import type { ModelInfo, ProviderConfig, ToolCall } from '@agent-nekko/shared';
import type { Provider, ChatRequest, ProviderChunk } from './types.js';
import { randomUUID } from 'node:crypto';
import { parseSSE } from './sse.js';
import { DecodeClock } from './decode-clock.js';

/**
 * ChatGPT-plan models. The Codex backend has no public /models route, so we
 * ship the current subscription model set as a curated list, the same way the
 * Anthropic provider does for Claude.
 */
const CHATGPT_MODELS: Array<{ id: string; name: string; ctx: number }> = [
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', ctx: 400000 },
  { id: 'gpt-5', name: 'GPT-5', ctx: 400000 },
  { id: 'codex-mini-latest', name: 'Codex Mini', ctx: 200000 },
];

/**
 * The Codex backend requires this beta header for Responses-API streaming and
 * a `chatgpt-account-id` header identifying the signed-in ChatGPT account.
 * `originator` matches what the first-party Codex CLI sends; `session_id`
 * scopes a conversation for the backend's caching/telemetry.
 */
const RESPONSES_BETA = 'responses=experimental';
const ORIGINATOR = 'codex_cli_rs';

const MISSING_ACCOUNT_ID =
  'This ChatGPT sign-in is missing an account id. Sign out and sign in again so it can be captured (sessions signed in before this version may lack one).';

/**
 * Client for the ChatGPT/Codex subscription endpoint: the Responses API over
 * SSE at `{baseUrl}/codex/responses`. Only usable with a subscription token —
 * the host injects the fresh OAuth access token into config.apiKey and the
 * ChatGPT account id into config.accountId.
 */
export class ChatGptProvider implements Provider {
  /** One session id per provider instance (≈ one agent run). */
  private readonly sessionId = randomUUID();

  constructor(public readonly config: ProviderConfig) {}

  private base(): string {
    return this.config.baseUrl.trim().replace(/\/+$/, '');
  }

  /**
   * Throws when the account id is absent: the backend 401s without it, and a
   * clear sign-in-again error beats a cryptic upstream rejection.
   */
  private headers(): Record<string, string> {
    if (!this.config.accountId) throw new Error(MISSING_ACCOUNT_ID);
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      'chatgpt-account-id': this.config.accountId,
      'OpenAI-Beta': RESPONSES_BETA,
      originator: ORIGINATOR,
      session_id: this.sessionId,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const custom = this.config.customModelId?.trim();
    const all = CHATGPT_MODELS.map((m) => ({
      id: m.id,
      providerId: this.config.id,
      name: m.name,
      contextLength: m.ctx,
    }));
    if (custom && !all.some((m) => m.id === custom)) {
      all.push({
        id: custom,
        providerId: this.config.id,
        name: `${custom} (custom)`,
        contextLength: 128_000,
      });
    }
    return all;
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    if (!this.config.apiKey) {
      return { ok: false, message: 'Not signed in. Sign in with ChatGPT in the provider settings.' };
    }
    if (!this.config.accountId) {
      return { ok: false, message: MISSING_ACCOUNT_ID };
    }
    return { ok: true, message: 'Signed in with a ChatGPT subscription' };
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.system,
      input: toResponseItems(req),
      tools: req.tools?.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      stream: true,
      store: false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxOutputTokens) body.max_output_tokens = req.maxOutputTokens;
    if (req.think === true) body.reasoning = { summary: 'auto' };

    let res: Response;
    try {
      res = await fetch(`${this.base()}/codex/responses`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      // The account-id guard above throws the friendly error; only real fetch
      // failures land here.
      throw new Error(friendlyError(e, this.base()));
    }
    req.onHeaders?.(res.headers);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chatgpt ${res.status}: ${text.slice(0, 200)}`);
    }

    // Times the decode phase for the tok/s figure: from the first generated
    // delta to the `response.completed` event that reports usage.
    const decode = new DecodeClock();

    for await (const data of parseSSE(res)) {
      let ev: any;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) {
            decode.mark();
            yield { type: 'text', delta: ev.delta as string };
          }
          break;
        case 'response.reasoning_summary_text.delta':
          if (ev.delta) {
            decode.mark();
            yield { type: 'reasoning', delta: ev.delta as string };
          }
          break;
        case 'response.output_item.done': {
          const item = ev.item;
          if (item?.type === 'function_call') {
            decode.mark();
            const call: ToolCall = {
              id: item.call_id ?? item.id,
              name: item.name,
              input: safeParse(item.arguments),
            };
            yield { type: 'tool_call', call };
          }
          break;
        }
        case 'response.completed': {
          decode.stop();
          const usage = ev.response?.usage;
          if (usage) {
            yield {
              type: 'usage',
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              outputMs: decode.elapsed(),
            };
          }
          yield { type: 'done' };
          return;
        }
        case 'response.incomplete': {
          // Hit the output cap (or another length stop): keep what streamed.
          decode.stop();
          const usage = ev.response?.usage;
          if (usage) {
            yield {
              type: 'usage',
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              outputMs: decode.elapsed(),
            };
          }
          yield { type: 'done' };
          return;
        }
        case 'response.failed':
        case 'error':
          throw new Error(
            `chatgpt response failed: ${
              ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? 'unknown error'
            }`,
          );
        default:
          break;
      }
    }
    yield { type: 'done' };
  }
}

/** Map normalized chat history onto Responses API input items. */
function toResponseItems(req: ChatRequest) {
  const out: any[] = [];
  for (const m of req.messages) {
    if (m.role === 'tool' && m.toolResult) {
      out.push({
        type: 'function_call_output',
        call_id: m.toolResult.toolCallId,
        output: m.toolResult.output,
      });
    } else if (m.role === 'assistant') {
      if (m.content) {
        out.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: m.content }],
        });
      }
      for (const c of m.toolCalls ?? []) {
        out.push({
          type: 'function_call',
          call_id: c.id,
          name: c.name,
          arguments: JSON.stringify(c.input),
        });
      }
    } else if (m.role === 'user') {
      const content: any[] = [{ type: 'input_text', text: m.content }];
      for (const url of m.images ?? []) {
        content.push({ type: 'input_image', image_url: url });
      }
      out.push({ type: 'message', role: 'user', content });
    }
    // role 'system' in history is covered by req.system -> instructions.
  }
  return out;
}

function safeParse(s: string | undefined): Record<string, unknown> {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Turn low-level fetch failures into actionable guidance. */
function friendlyError(e: unknown, url: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return 'Request cancelled.';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) {
    return `Can't reach ChatGPT at ${url}. Check the network connection.`;
  }
  return msg;
}
