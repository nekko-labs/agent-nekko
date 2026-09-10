import type { ChatMessage, ModelInfo, ProviderConfig, ToolCall } from '@agent-nekko/shared';

/** A tool the model may call, in a provider-neutral shape. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema for the input. */
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  system?: string;
  tools?: ToolSpec[];
  temperature?: number;
  /**
   * Reasoning toggle for models that support it: `true` requests thinking,
   * `false` suppresses it, `undefined` leaves the server/model default. Providers
   * translate this to their native knob (Ollama `think`, OpenAI-compatible
   * `chat_template_kwargs.enable_thinking`) and ignore it where unsupported.
   */
  think?: boolean;
  /**
   * Hard cap on tokens this response may generate. Without one, a model that
   * degenerates into a loop streams until it fills its own context window, so
   * every provider sends its native equivalent (`max_tokens`, `num_predict`).
   */
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Hook for the host to read the raw HTTP response headers (rate limits, etc.). */
  onHeaders?: (headers: Headers) => void;
}

/** Streamed chunk from a provider, normalized. */
export type ProviderChunk =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      /**
       * Milliseconds the model spent generating `outputTokens`: the decode phase
       * only. It excludes queueing, prompt processing (time to first token), and
       * everything that happens between responses, so `outputTokens / outputMs`
       * is the throughput figure a local runtime reports for the same run.
       * Omitted when the provider gives us nothing to measure.
       */
      outputMs?: number;
    }
  | { type: 'done' };

export interface Provider {
  readonly config: ProviderConfig;
  /** List available models. */
  listModels(): Promise<ModelInfo[]>;
  /** Stream a chat completion. */
  chat(req: ChatRequest): AsyncIterable<ProviderChunk>;
  /** Lightweight reachability test. */
  test(): Promise<{ ok: boolean; message: string }>;
}
