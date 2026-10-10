import type {
  LoadParams,
  LoadResult,
  ModelFacts,
  RuntimeCapabilities,
  RuntimeDetection,
  RuntimeKind,
  RuntimeStatus,
  StartOptions,
  StopResult,
} from '@agent-nekko/shared';

/**
 * One interface over three quite different servers.
 *
 * Ollama and LM Studio are model managers: a long-lived server you send models
 * to. vLLM is a process per model, configured entirely at launch. Rather than
 * scatter that difference through the codebase, each adapter declares what it can
 * do through `capabilities`, and the UI asks the capability rather than the kind.
 *
 * Optional methods are the strong form of the same idea. `start` being undefined
 * is not an oversight, it is the contract: there is no way to ask a vLLM adapter
 * to start something.
 */
export interface RuntimeAdapter {
  kind: RuntimeKind;
  capabilities: RuntimeCapabilities;
  /** Is it installed, is it running, what version. */
  detect(baseUrl: string): Promise<RuntimeDetection>;
  /** Live state: health, residency, metrics. */
  status(baseUrl: string): Promise<RuntimeStatus>;
  /** Everything this server can serve, with the geometry the planner needs. */
  listModels(baseUrl: string): Promise<ModelFacts[]>;
  start?(opts: StartOptions): Promise<RuntimeStatus>;
  stop?(baseUrl: string, force?: boolean): Promise<StopResult>;
  load?(baseUrl: string, modelId: string, params: LoadParams): Promise<LoadResult>;
  unload?(baseUrl: string, modelId: string): Promise<LoadResult>;
}

/**
 * The I/O an adapter is allowed to do, injected so tests drive adapters with
 * recorded fixtures instead of a live server. Nothing in an adapter reaches for
 * `fetch` or `execFile` directly.
 */
export interface RuntimeContext {
  fetch: typeof fetch;
  /** Run a command, resolving stdout, or null on failure or timeout. */
  run: (cmd: string, args: string[], timeoutMs?: number) => Promise<string | null>;
}

/** Fetch JSON with a timeout, resolving null on any failure. */
export async function getJson<T>(
  ctx: RuntimeContext,
  url: string,
  timeoutMs = 4000,
): Promise<T | null> {
  try {
    const res = await withTimeout(ctx.fetch(url), timeoutMs);
    if (!res?.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** POST JSON with a timeout, resolving the Response or null. */
export async function postJson(
  ctx: RuntimeContext,
  url: string,
  body: unknown,
  timeoutMs = 10_000,
): Promise<Response | null> {
  try {
    return await withTimeout(
      ctx.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      timeoutMs,
    );
  } catch {
    return null;
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Trim a trailing `/v1` so the native API root can be addressed. */
export function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** The base URL with no trailing slash. */
export function trimUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}
