import type { ModelInfo, ProviderConfig, ToolCall } from '@agent-nekko/shared';
import type { Provider, ChatRequest, ProviderChunk } from './types.js';
import { parseSSE } from './sse.js';
import { DecodeClock } from './decode-clock.js';

/** Known Claude models surfaced when the /models endpoint isn't used. */
const CLAUDE_MODELS: Array<{ id: string; name: string; ctx: number }> = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', ctx: 200000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', ctx: 200000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', ctx: 200000 },
];

/**
 * Subscription (OAuth) requests ride the Claude Code public client. The
 * endpoint requires this beta flag and validates that the first system block
 * is the Claude Code identity line, per the token's terms of use.
 */
const OAUTH_BETA = 'oauth-2025-04-20';
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Client for the Anthropic Messages API (native, with SSE streaming). */
export class AnthropicProvider implements Provider {
  constructor(public readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    // Subscription mode: the host injects a fresh OAuth access token into
    // config.apiKey, which goes out as a Bearer token, not an x-api-key.
    if (this.config.auth === 'subscription') {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey ?? ''}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
      };
    }
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  /**
   * Subscription tokens are only valid for requests that identify as Claude
   * Code, so the system prompt goes out as a block array with the required
   * prefix first; the app's real system prompt follows as a second block.
   */
  private systemParam(system: string | undefined) {
    if (this.config.auth !== 'subscription') return system;
    const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX }];
    if (system) blocks.push({ type: 'text', text: system });
    return blocks;
  }

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS.map((m) => ({
      id: m.id,
      providerId: this.config.id,
      name: m.name,
      contextLength: m.ctx,
    }));
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (this.config.auth === 'subscription') {
      return this.config.apiKey
        ? { ok: true, message: 'Signed in with a Claude subscription' }
        : { ok: false, message: 'Not signed in. Sign in with Claude in the provider settings.' };
    }
    if (!this.config.apiKey) return { ok: false, message: 'Missing API key' };
    return { ok: true, message: 'API key set' };
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    const body = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 4096,
      stream: true,
      temperature: req.temperature ?? 0.7,
      system: this.systemParam(req.system),
      messages: this.toAnthropicMessages(req),
      tools: req.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    };

    const res = await fetch(`${this.config.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    req.onHeaders?.(res.headers);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`anthropic ${res.status}: ${text.slice(0, 200)}`);
    }

    let curTool: { id: string; name: string; json: string } | null = null;
    let inputTokens = 0;
    // Times the decode phase for the tok/s figure: from the first generated
    // token to the `message_delta` that reports the output count.
    const decode = new DecodeClock();

    for await (const data of parseSSE(res)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'message_start':
          inputTokens = ev.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            curTool = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
          }
          break;
        case 'content_block_delta':
          // Tool arguments are generated tokens too, so they start the clock even
          // though they surface as one `tool_call` at the end of the block.
          decode.mark();
          if (ev.delta?.type === 'text_delta') {
            yield { type: 'text', delta: ev.delta.text as string };
          } else if (ev.delta?.type === 'input_json_delta' && curTool) {
            curTool.json += ev.delta.partial_json;
          }
          break;
        case 'content_block_stop':
          if (curTool) {
            const call: ToolCall = { id: curTool.id, name: curTool.name, input: safeParse(curTool.json) };
            yield { type: 'tool_call', call };
            curTool = null;
          }
          break;
        case 'message_delta':
          if (ev.usage?.output_tokens != null) {
            decode.stop();
            yield { type: 'usage', inputTokens, outputTokens: ev.usage.output_tokens, outputMs: decode.elapsed() };
          }
          break;
        case 'message_stop':
          yield { type: 'done' };
          return;
      }
    }
    yield { type: 'done' };
  }

  private toAnthropicMessages(req: ChatRequest) {
    const out: any[] = [];
    for (const m of req.messages) {
      if (m.role === 'tool' && m.toolResult) {
        out.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolResult.toolCallId, content: m.toolResult.output }],
        });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls) {
          content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
        }
        out.push({ role: 'assistant', content });
      } else if (m.role === 'user' || m.role === 'assistant') {
        out.push({
          role: m.role,
          content: m.role === 'user' && m.images?.length
            ? [
                { type: 'text', text: m.content },
                ...m.images.map((url) => {
                  const match = url.match(/^data:([^;]+);base64,(.+)$/);
                  return {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: match?.[1] ?? 'application/octet-stream',
                      data: match?.[2] ?? url,
                    },
                  };
                }),
              ]
            : m.content,
        });
      }
    }
    return out;
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}
