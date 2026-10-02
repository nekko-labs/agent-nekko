import type { ModelInfo, ProviderConfig, ToolCall } from '@agent-nekko/shared';
import type { Provider, ChatRequest, ProviderChunk, ToolSpec } from './types.js';
import { parseSSE } from './sse.js';
import { DecodeClock } from './decode-clock.js';

/**
 * Client for any OpenAI-compatible /chat/completions endpoint. Covers OpenAI,
 * OpenRouter, LM Studio, vLLM, and generic openai-compat servers, they only
 * differ in base URL and auth header, which come from the ProviderConfig.
 */
export class OpenAICompatProvider implements Provider {
  constructor(public readonly config: ProviderConfig) {}

  /**
   * Normalized API base. LM Studio / vLLM / generic servers expose the OpenAI
   * routes under `/v1`, but users often paste just `http://host:port`. If the
   * configured URL has no path (or a bare `/`), append `/v1` so `/models` and
   * `/chat/completions` resolve. URLs that already include a path are left alone.
   */
  private base(): string {
    let url = this.config.baseUrl.trim().replace(/\/+$/, '');
    try {
      const u = new URL(url);
      if (u.pathname === '' || u.pathname === '/') url = `${url}/v1`;
    } catch {
      /* leave as-is if it isn't a parseable URL */
    }
    return url;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    if (this.config.kind === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/nekko-labs/agent-nekko';
      h['X-Title'] = 'Agent Nekko';
    }
    return h;
  }

  async listModels(): Promise<ModelInfo[]> {
    // LM Studio's native REST API (/api/v0/models) reports per-model load state,
    // which the OpenAI-compatible /v1/models route does not. Prefer it for LM
    // Studio so the Models page can show what's loaded; fall back to /v1/models.
    if (this.config.kind === 'lmstudio') {
      const lm = await this.lmStudioModels().catch(() => null);
      if (lm) return lm;
    }
    const res = await fetch(`${this.base()}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`listModels ${res.status}: ${extractApiError(await res.text().catch(() => ''))}`);
    const json = (await res.json()) as {
      data?: Array<{
        id: string;
        name?: string;
        context_length?: number;
        top_provider?: { context_length?: number };
        pricing?: { prompt?: string; completion?: string };
        supported_parameters?: string[];
        /** The Nekko engine's extras: where the file lives and its load state. */
        max_context_length?: number;
        path?: string;
        location?: string;
        state?: string;
      }>;
    };
    const openrouter = this.config.kind === 'openrouter';
    return (json.data ?? []).map((m) => {
      const input = Number(m.pricing?.prompt);
      const output = Number(m.pricing?.completion);
      const priced = openrouter && Number.isFinite(input) && Number.isFinite(output);
      const details: Record<string, string> = {
        ...(openrouter && m.supported_parameters?.includes('tools') ? { tools: 'yes' } : {}),
        // The Nekko engine sends the file path and the folder it lives in, so
        // pickers can lead with the name and group by where the model lives.
        ...(typeof m.path === 'string' ? { path: m.path } : {}),
        ...(typeof m.location === 'string' ? { location: m.location } : {}),
      };
      return {
        id: m.id,
        providerId: this.config.id,
        // A display name only from the servers that send a meaningful one:
        // OpenRouter's "OpenAI: GPT-5" and the local engines' friendly model
        // names. OpenAI's own list carries none, so a stray field there stays
        // the id it always was.
        name: serverNamesModels(this.config.kind) && m.name ? m.name : m.id,
        contextLength: m.context_length ?? m.top_provider?.context_length ?? m.max_context_length,
        ...(priced ? { inputPricePerM: input * 1e6, outputPricePerM: output * 1e6 } : {}),
        ...(Object.keys(details).length ? { details } : {}),
        // vLLM serves exactly the model(s) it was launched with — always
        // resident. The engine reports residency per row instead.
        ...(this.config.kind === 'vllm'
          ? { loaded: true }
          : m.state === 'loaded' || m.state === 'not-loaded'
            ? { loaded: m.state === 'loaded' }
            : {}),
      };
    });
  }

  /** LM Studio native model list with load state (`/api/v0/models`). */
  private async lmStudioModels(): Promise<ModelInfo[]> {
    const root = this.base().replace(/\/v1$/, '');
    const res = await fetch(`${root}/api/v0/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`lmstudio models ${res.status}`);
    const json = (await res.json()) as {
      data?: Array<{ id: string; state?: string; loaded_context_length?: number; max_context_length?: number }>;
    };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      providerId: this.config.id,
      name: m.id,
      contextLength: m.loaded_context_length ?? m.max_context_length,
      loaded: m.state === 'loaded',
    }));
  }

  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      // OpenRouter's /key endpoint answers with the key's label and remaining
      // credits — a real auth check, unlike /models which is public there.
      if (this.config.kind === 'openrouter') {
        if (!this.config.apiKey) return { ok: false, message: 'Paste an API key or sign in with OpenRouter first.' };
        const res = await fetch(`${this.base()}/key`, { headers: this.headers() });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: 'OpenRouter rejected this key — check it or regenerate it.' };
        }
        if (!res.ok) return { ok: false, message: `OpenRouter answered HTTP ${res.status}.` };
        const json = (await res.json().catch(() => null)) as {
          data?: { limit_remaining?: number | null; limit?: number | null; usage?: number };
        } | null;
        const d = json?.data;
        const remaining = d?.limit_remaining ?? (d?.limit != null && d?.usage != null ? d.limit - d.usage : null);
        return {
          ok: true,
          message: `Connected${remaining != null ? ` — $${Math.max(0, remaining).toFixed(2)} left` : ' — unlimited'}`,
        };
      }
      const res = await fetch(`${this.base()}/models`, { headers: this.headers() });
      if (res.ok) return { ok: true, message: 'Connected' };
      const detail = extractApiError(await res.text().catch(() => ''));
      return {
        ok: false,
        message: `HTTP ${res.status}${res.status === 401 ? ', check your API key' : ''}${detail ? `: ${detail}` : ''}`,
      };
    } catch (e) {
      return { ok: false, message: friendlyError(e, this.base()) };
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    // Reasoning toggle: local servers (LM Studio / vLLM / generic) accept
    // `chat_template_kwargs.enable_thinking` (Qwen3 and friends). Only sent to
    // local kinds — cloud endpoints reject unknown body fields.
    const localKind =
      this.config.kind === 'lmstudio' ||
      this.config.kind === 'vllm' ||
      this.config.kind === 'llamacpp' ||
      this.config.kind === 'openai-compat';
    const body = {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: req.temperature ?? 0.7,
      // Output cap: without it a looping local model streams until its context
      // window fills. `max_tokens` is honoured by every openai-compat server we
      // target (newer OpenAI models also accept it as a deprecated alias).
      ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
      messages: this.toOpenAIMessages(req),
      tools: req.tools?.map(toOpenAITool),
      ...(req.think !== undefined && localKind ? { chat_template_kwargs: { enable_thinking: req.think } } : {}),
    };

    let res: Response;
    try {
      res = await fetch(`${this.base()}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      throw new Error(friendlyError(e, this.base()));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // OpenAI-style bodies carry { error: { message } } — surface that message
      // instead of raw JSON so 401/402/429 replies read like sentences.
      throw new Error(`Model request failed (HTTP ${res.status})${text ? `: ${extractApiError(text)}` : ''}`);
    }

    // Accumulate streamed tool-call fragments by index.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    // Times the decode phase for the tok/s figure. `include_usage` puts the usage
    // chunk after the last content chunk, so the clock covers exactly the span in
    // which the tokens it reports were generated.
    const decode = new DecodeClock();

    for await (const data of parseSSE(res)) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      // Reasoning models (e.g. Gemma/DeepSeek on LM Studio) stream their chain
      // of thought as `reasoning_content` (or `reasoning`) before the answer.
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) {
        decode.mark();
        yield { type: 'reasoning', delta: reasoning as string };
      }
      if (delta?.content) {
        decode.mark();
        yield { type: 'text', delta: delta.content as string };
      }
      if (delta?.tool_calls) {
        // Tool arguments are generated tokens too, so a response that only calls
        // a tool still has a decode rate to report.
        decode.mark();
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: tc.id ?? `call_${idx}`, name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
      if (chunk.usage) {
        decode.stop();
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          outputMs: decode.elapsed(),
        };
      }
      if (choice?.finish_reason) {
        for (const acc of toolAcc.values()) {
          const call: ToolCall = {
            id: acc.id,
            name: acc.name,
            input: safeParse(acc.args),
          };
          yield { type: 'tool_call', call };
        }
        toolAcc.clear();
      }
    }
    yield { type: 'done' };
  }

  private toOpenAIMessages(req: ChatRequest) {
    const out: any[] = [];
    if (req.system) out.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      if (m.role === 'tool' && m.toolResult) {
        out.push({ role: 'tool', tool_call_id: m.toolResult.toolCallId, content: m.toolResult.output });
      } else if (m.role === 'assistant' && m.toolCalls?.length) {
        out.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          })),
        });
      } else {
        out.push({
          role: m.role,
          content: m.role === 'user' && m.images?.length
            ? [
                { type: 'text', text: m.content },
                ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
              ]
            : m.content,
        });
      }
    }
    return out;
  }
}

/** Kinds whose /models rows carry a display name worth showing. */
function serverNamesModels(kind: ProviderConfig['kind']): boolean {
  return (
    kind === 'openrouter' ||
    kind === 'llamacpp' ||
    kind === 'openai-compat' ||
    kind === 'lmstudio' ||
    kind === 'vllm'
  );
}

function toOpenAITool(t: ToolSpec) {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

/** Pull a readable message out of an API error body, or truncate raw text. */
function extractApiError(text: string): string {
  const parsed = safeParse(text);
  const msg = (parsed.error as { message?: unknown } | undefined)?.message;
  return typeof msg === 'string' ? msg : text.slice(0, 200);
}

/** Turn low-level fetch failures into actionable guidance. */
export function friendlyError(e: unknown, url: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/abort/i.test(msg)) return 'Request cancelled.';
  if (/ECONNREFUSED|fetch failed|Failed to fetch|ENOTFOUND|ETIMEDOUT|network/i.test(msg)) {
    return `Can't reach the model server at ${url}. Is it running and reachable on the network?`;
  }
  return msg;
}
