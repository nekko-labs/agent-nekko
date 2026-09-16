import { spawn, type ChildProcess } from 'child_process';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { createServer as createProbe } from 'net';
import type {
  EngineSettings,
  GpuStats,
  LoadParams,
  LoadResult,
  LocalModel,
  ResidentModel,
  StopResult,
} from '@agent-nekko/shared';

/**
 * The Nekko engine's server: one address, several models.
 *
 * `llama-server` serves exactly one model per process. LM Studio parity needs
 * several models resident behind one endpoint, so this is a small router in front
 * of a child process per loaded model. The router is what the user (and any other
 * tool on the machine) points at; the children are an implementation detail that
 * never appears in a URL.
 *
 *   router :11500/v1  ->  llama-server :49xxx   (qwen3-8b)
 *                     ->  llama-server :49xxx   (gemma3-12b)
 *
 * Three behaviours come from being the router rather than a wrapper: a request
 * for a model that is not loaded can load it (JIT, as LM Studio does), an idle
 * model can be evicted on a timer, and the endpoint stays valid across loads and
 * unloads, so a chat configured once keeps working.
 *
 * It is OpenAI-compatible because llama-server already is: bodies are streamed
 * through untouched in both directions, which is what keeps token streaming and
 * tool calls working without this file knowing what either looks like.
 */

/** A cold start of a large model off a slow disk is genuinely slow. */
const LOAD_BUDGET_MS = 600_000;
const HEALTH_INTERVAL_MS = 400;
/** How often idle models are checked against their TTL. */
const SWEEP_INTERVAL_MS = 30_000;
const LOG_LINES = 200;

interface Child {
  modelId: string;
  child: ChildProcess;
  port: number;
  params: LoadParams;
  startedAt: number;
  lastUsedAt: number;
  log: string[];
  /** Measured GPU memory this load took, when a probe could measure it. */
  vramBytes?: number;
  sizeBytes: number;
  contextTokens?: number;
}

/**
 * Quitting Agent Nekko must not leave orphaned model servers holding VRAM.
 *
 * One process-level hook for the module rather than one per engine: a listener
 * per instance is a slow leak in anything that constructs more than one, and the
 * set makes the cleanup order explicit.
 */
const liveKillers = new Set<() => void>();
process.once('exit', () => {
  for (const kill of liveKillers) kill();
});

export interface EngineServerDeps {
  settings: () => EngineSettings;
  /** Absolute path to `llama-server`, or undefined when none is installed. */
  binPath: () => Promise<string | undefined>;
  findModel: (id: string) => Promise<LocalModel | undefined>;
  listModels: () => Promise<LocalModel[]>;
  getGpuStats: () => Promise<GpuStats | null>;
  spawnFn?: typeof spawn;
}

export function createEngineServer(deps: EngineServerDeps) {
  const spawnFn = deps.spawnFn ?? spawn;
  const children = new Map<string, Child>();
  const log: string[] = [];
  let server: Server | null = null;
  let sweeper: ReturnType<typeof setInterval> | null = null;
  let startedAt: number | undefined;
  /** Loads are serialized: two at once make the VRAM measurement meaningless. */
  let loadChain: Promise<unknown> = Promise.resolve();

  const killAll = () => {
    for (const c of children.values()) {
      try {
        c.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  liveKillers.add(killAll);

  /* ------------------------------------------------------------- lifecycle */

  async function start(): Promise<{ ok: boolean; message: string }> {
    if (server) return { ok: true, message: 'The engine is already running.' };
    const bin = await deps.binPath();
    if (!bin) {
      return { ok: false, message: 'No engine is installed yet. Install one from the Models tab first.' };
    }
    const settings = deps.settings();
    const host = settings.bind === 'lan' ? '0.0.0.0' : '127.0.0.1';

    const next = createServer((req, res) => {
      void handle(req, res).catch((e: Error) => fail(res, 502, e.message));
    });
    // A model load can take minutes and a long generation longer; the default
    // two-minute socket timeout would cut both off mid-stream.
    next.requestTimeout = 0;
    next.headersTimeout = 0;
    next.setTimeout(0);

    const bound = await new Promise<string | null>((resolve) => {
      next.once('error', (e: NodeJS.ErrnoException) => {
        resolve(
          e.code === 'EADDRINUSE'
            ? `Port ${settings.port} is already in use. Pick another port for the engine.`
            : e.message,
        );
      });
      next.listen(settings.port, host, () => resolve(null));
    });
    if (bound) return { ok: false, message: bound };

    server = next;
    startedAt = Date.now();
    liveKillers.add(killAll);
    sweeper = setInterval(() => void sweepIdle(), SWEEP_INTERVAL_MS);
    sweeper.unref?.();
    push(`Engine listening on http://${host}:${settings.port}/v1`);
    return { ok: true, message: `The engine is serving on port ${settings.port}.` };
  }

  async function stop(): Promise<StopResult> {
    if (!server) return { ok: true, message: 'The engine was not running.' };
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
    for (const id of [...children.keys()]) await unload(id);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    startedAt = undefined;
    liveKillers.delete(killAll);
    push('Engine stopped.');
    return { ok: true, message: 'Stopped the engine.' };
  }

  /* ------------------------------------------------------------ load state */

  /**
   * Load a model into its own `llama-server`.
   *
   * Serialized against other loads, both so two large models cannot race each
   * other into VRAM and so the before/after GPU reading that measures this load
   * is not polluted by another one landing halfway through.
   */
  function load(modelId: string, params: LoadParams = {}): Promise<LoadResult> {
    const run = loadChain.then(() => doLoad(modelId, params));
    loadChain = run.catch(() => {});
    return run;
  }

  async function doLoad(modelId: string, params: LoadParams): Promise<LoadResult> {
    const existing = children.get(modelId);
    if (existing) {
      // A load with different settings is a reload, which is what the drawer's
      // "Reload with these settings" means.
      if (sameParams(existing.params, params)) {
        existing.lastUsedAt = Date.now();
        return { ok: true, message: `${modelId} is already loaded.` };
      }
      await unload(modelId);
    }

    const bin = await deps.binPath();
    if (!bin) return { ok: false, message: 'No engine is installed.' };
    const model = await deps.findModel(modelId);
    if (!model) return { ok: false, message: `${modelId} is not in the library.` };

    const settings = deps.settings();
    // Make room before spending minutes on a load that would immediately push
    // something else out anyway.
    while (children.size >= Math.max(1, settings.maxLoaded)) {
      const oldest = [...children.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!oldest) break;
      push(`Unloading ${oldest.modelId} to make room for ${modelId}.`);
      await unload(oldest.modelId);
    }

    const port = await freePort();
    const args = buildArgs(model, port, params);
    const before = await freeVramBytes();

    const childLog: string[] = [];
    let child: ChildProcess;
    try {
      child = spawnFn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }

    const capture = (buf: Buffer | string) => {
      for (const line of String(buf).split('\n')) {
        if (line.trim()) childLog.push(line.trimEnd());
      }
      if (childLog.length > LOG_LINES) childLog.splice(0, childLog.length - LOG_LINES);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let exited: string | null = null;
    child.on('error', (e) => {
      exited = e.message;
    });
    child.on('exit', (code, signal) => {
      exited = exited ?? `The model server exited (code ${code ?? signal}).`;
      children.delete(modelId);
    });

    const deadline = Date.now() + LOAD_BUDGET_MS;
    while (Date.now() < deadline) {
      if (exited) {
        // The captured output is the answer: "failed to allocate" and "unknown
        // argument" are different problems with different fixes.
        push(...childLog.slice(-4));
        return { ok: false, message: childLog.slice(-2).join(' ') || exited };
      }
      if (await healthy(port)) {
        const after = await freeVramBytes();
        const entry: Child = {
          modelId,
          child,
          port,
          params,
          startedAt: Date.now(),
          lastUsedAt: Date.now(),
          log: childLog,
          // Measured, not projected: what the GPU reported before minus after.
          // Absent when there is no GPU probe, which is honest rather than zero.
          vramBytes: before !== null && after !== null ? Math.max(0, before - after) : undefined,
          sizeBytes: model.sizeBytes,
          contextTokens: params.contextTokens,
        };
        children.set(modelId, entry);
        push(`Loaded ${modelId} on port ${port}.`);
        return { ok: true, message: `Loaded ${modelId}.` };
      }
      await sleep(HEALTH_INTERVAL_MS);
    }

    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    return { ok: false, message: 'The model did not finish loading in time.' };
  }

  async function unload(modelId: string): Promise<LoadResult> {
    const entry = children.get(modelId);
    if (!entry) return { ok: false, message: `${modelId} is not loaded.` };
    children.delete(modelId);
    try {
      entry.child.kill('SIGTERM');
      const timer = setTimeout(() => {
        try {
          entry.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 3000);
      timer.unref?.();
    } catch {
      /* already gone */
    }
    push(`Unloaded ${modelId}.`);
    return { ok: true, message: `Unloaded ${modelId}.` };
  }

  /** Evict anything past its TTL. 0 means "stay resident until told otherwise". */
  async function sweepIdle(): Promise<void> {
    const settings = deps.settings();
    const now = Date.now();
    for (const entry of [...children.values()]) {
      const ttl = (entry.params.ttlSeconds ?? settings.idleTtlSeconds) * 1000;
      if (ttl > 0 && now - entry.lastUsedAt > ttl) {
        push(`${entry.modelId} was idle, unloading.`);
        await unload(entry.modelId);
      }
    }
  }

  function resident(): ResidentModel[] {
    const settings = deps.settings();
    return [...children.values()].map((c) => {
      const ttl = (c.params.ttlSeconds ?? settings.idleTtlSeconds) * 1000;
      return {
        id: c.modelId,
        sizeBytes: c.sizeBytes,
        vramBytes: c.vramBytes,
        contextLength: c.contextTokens,
        expiresAt: ttl > 0 ? c.lastUsedAt + ttl : undefined,
      };
    });
  }

  /* --------------------------------------------------------------- routing */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const settings = deps.settings();
    applyCors(res, settings, req.headers.origin);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // Health is deliberately unauthenticated: it carries nothing, and something
    // has to be able to tell whether the port is ours without a key.
    if (path === '/health' || path === '/') {
      return json(res, 200, { status: 'ok', service: 'agent-nekko-engine', models: children.size });
    }
    if (settings.apiKey && !authorized(req, settings.apiKey)) {
      return json(res, 401, { error: { message: 'Invalid API key.', type: 'invalid_request_error' } });
    }

    if (path === '/v1/models' || path === '/models') return listModelsRoute(res);
    if (path.startsWith('/v1/models/') || path.startsWith('/models/')) {
      const id = decodeURIComponent(path.replace(/^\/(v1\/)?models\//, ''));
      const model = await deps.findModel(id);
      return model
        ? json(res, 200, modelRow(model, children.has(id)))
        : json(res, 404, { error: { message: `No model named ${id}.`, type: 'invalid_request_error' } });
    }

    const inference = /^\/(v1\/)?(chat\/completions|completions|embeddings|rerank|infill)$/.test(path);
    if (!inference) {
      return json(res, 404, { error: { message: `Unknown route ${path}.`, type: 'invalid_request_error' } });
    }

    const body = await readBody(req);
    const requested = pickModelId(body);
    const target = await resolveTarget(requested);
    if ('error' in target) return json(res, target.status, { error: { message: target.error, type: 'invalid_request_error' } });

    target.entry.lastUsedAt = Date.now();
    proxy(req, res, target.entry.port, path.startsWith('/v1/') ? path : `/v1${path}`, body);
  }

  async function listModelsRoute(res: ServerResponse): Promise<void> {
    const models = await deps.listModels();
    json(res, 200, {
      object: 'list',
      data: models.map((m) => modelRow(m, children.has(m.id))),
    });
  }

  /**
   * Which child should serve this request.
   *
   * A model that is not loaded is loaded here when JIT is on, which is the
   * behaviour that makes the endpoint usable from another app: point Cursor at
   * it, name a model, and it works without visiting our UI first.
   */
  async function resolveTarget(
    requested: string | undefined,
  ): Promise<{ entry: Child } | { error: string; status: number }> {
    if (requested) {
      const loaded = children.get(requested);
      if (loaded) return { entry: loaded };
      const known = await deps.findModel(requested);
      if (!known) return { error: `No model named ${requested}. Check /v1/models.`, status: 404 };
      if (!deps.settings().jitLoad) {
        return { error: `${requested} is not loaded, and load-on-demand is off.`, status: 409 };
      }
      const result = await load(requested, known.preset ?? {});
      const entry = children.get(requested);
      if (!entry) return { error: result.message ?? `Couldn't load ${requested}.`, status: 503 };
      return { entry };
    }

    // No model named: the most recently used one is the least surprising answer,
    // and a client that names nothing has no expectation to violate.
    const recent = [...children.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    if (recent) return { entry: recent };
    return { error: 'No model is loaded and the request named none.', status: 409 };
  }

  /**
   * Pipe the request to the child and the reply straight back.
   *
   * Headers and body pass through untouched in both directions, which is what
   * keeps streaming, tool calls, and any field llama.cpp adds later working
   * without this file being taught about them.
   */
  function proxy(req: IncomingMessage, res: ServerResponse, port: number, path: string, body: Buffer): void {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: req.method,
        headers: {
          'content-type': req.headers['content-type'] ?? 'application/json',
          'content-length': String(body.length),
          accept: req.headers.accept ?? '*/*',
        },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, stripHopByHop(up.headers));
        up.pipe(res);
      },
    );
    upstream.setTimeout(0);
    upstream.on('error', (e) => fail(res, 502, `The model server stopped responding: ${e.message}`));
    // A client that hangs up mid-generation should stop the generation too,
    // rather than leaving the model producing tokens nobody will read.
    res.on('close', () => {
      if (!res.writableEnded) upstream.destroy();
    });
    upstream.end(body);
  }

  /* ----------------------------------------------------------------- state */

  function status() {
    return {
      running: server !== null,
      startedAt,
      resident: resident(),
      log: log.slice(-40),
      port: deps.settings().port,
    };
  }

  function push(...lines: string[]): void {
    for (const line of lines) log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
    if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
  }

  async function freeVramBytes(): Promise<number | null> {
    const gpu = await deps.getGpuStats().catch(() => null);
    return gpu && gpu.devices.length > 0 ? gpu.freeMB * 1024 * 1024 : null;
  }

  return { start, stop, load, unload, status, resident, isRunning: () => server !== null, loadedIds: () => [...children.keys()] };
}

export type EngineServer = ReturnType<typeof createEngineServer>;

/* --------------------------------------------------------------- helpers */

/**
 * The `llama-server` command line for one load.
 *
 * Every flag is conditional on the parameter being set, so an unset control means
 * "llama.cpp's own default" rather than a value we invented. That matters for
 * threads and batch sizes in particular, where the engine's default is tuned to
 * the machine and ours would not be.
 */
export function buildArgs(model: LocalModel, port: number, params: LoadParams): string[] {
  const args = [
    '--model', model.path,
    '--alias', model.id,
    '--host', '127.0.0.1',
    '--port', String(port),
  ];
  if (params.contextTokens) args.push('--ctx-size', String(params.contextTokens));
  if (params.gpuLayers !== undefined) args.push('--n-gpu-layers', String(params.gpuLayers));
  if (params.parallelSlots && params.parallelSlots > 1) args.push('--parallel', String(params.parallelSlots));
  if (params.batchSize) args.push('--batch-size', String(params.batchSize));
  if (params.ubatchSize) args.push('--ubatch-size', String(params.ubatchSize));
  if (params.threads) args.push('--threads', String(params.threads));
  if (params.kvCacheDtype && params.kvCacheDtype !== 'f16') {
    // llama.cpp names the KV types the same way it names quantizations, and K
    // and V are set separately.
    args.push('--cache-type-k', params.kvCacheDtype, '--cache-type-v', params.kvCacheDtype);
  }
  if (params.flashAttention !== undefined) args.push('--flash-attn', params.flashAttention ? 'on' : 'off');
  if (params.mmap === false) args.push('--no-mmap');
  if (params.mlock) args.push('--mlock');
  if (params.ropeFreqBase) args.push('--rope-freq-base', String(params.ropeFreqBase));
  if (params.ropeFreqScale) args.push('--rope-freq-scale', String(params.ropeFreqScale));
  if (params.seed !== undefined) args.push('--seed', String(params.seed));
  // Embedding models answer /v1/embeddings only in embedding mode, and a chat
  // request to one is a mistake worth failing loudly rather than serving.
  if (model.architecture && /bert|embed/i.test(model.architecture)) args.push('--embedding');
  return args;
}

function modelRow(model: LocalModel, loaded: boolean) {
  return {
    id: model.id,
    object: 'model',
    created: Math.floor(model.addedAt / 1000),
    owned_by: 'agent-nekko',
    // Extras beyond the OpenAI schema, which compatible clients ignore and ours
    // uses to show state without a second request.
    state: loaded ? 'loaded' : 'not-loaded',
    max_context_length: model.maxContext,
    quantization: model.quantization,
    size_bytes: model.sizeBytes,
  };
}

function sameParams(a: LoadParams, b: LoadParams): boolean {
  const keys: Array<keyof LoadParams> = [
    'contextTokens', 'gpuLayers', 'kvCacheDtype', 'parallelSlots', 'batchSize',
    'ubatchSize', 'threads', 'flashAttention', 'mmap', 'mlock', 'ropeFreqBase',
    'ropeFreqScale', 'seed',
  ];
  return keys.every((k) => a[k] === b[k]);
}

function pickModelId(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown };
    return typeof parsed.model === 'string' && parsed.model ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

function authorized(req: IncomingMessage, key: string): boolean {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === key || req.headers['x-api-key'] === key;
}

/**
 * CORS, off unless asked for.
 *
 * A browser page that can reach this port can also read whatever it generates,
 * so the allowed origins are a setting rather than a default, and `*` is
 * something the user types.
 */
function applyCors(res: ServerResponse, settings: EngineSettings, origin?: string): void {
  const allowed = (settings.corsOrigins ?? '').trim();
  if (!allowed) return;
  const list = allowed.split(',').map((s) => s.trim()).filter(Boolean);
  const value = list.includes('*') ? '*' : origin && list.includes(origin) ? origin : null;
  if (!value) return;
  res.setHeader('access-control-allow-origin', value);
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
}

/** Headers that describe one hop and must not be copied to the next. */
function stripHopByHop(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  json(res, status, { error: { message, type: 'server_error' } });
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    // llama-server reports `loading model` before it is ready to serve.
    return body.status === 'ok';
  } catch {
    return false;
  }
}

/** Ask the OS for a free port by binding one and letting go. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createProbe();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('could not reserve a port'))));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
