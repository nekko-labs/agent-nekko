import {
  RUNTIME_CAPABILITIES,
  type LoadParams,
  type LoadResult,
  type ModelFacts,
  type ResidentModel,
  type RuntimeDetection,
  type RuntimeStatus,
  type StartOptions,
  type StopResult,
} from '@agent-nekko/shared';
import { isLocalhostUrl, lmsBin } from '../lms.js';
import { apiRoot, getJson, trimUrl, type RuntimeAdapter, type RuntimeContext } from './types.js';

/**
 * LM Studio adapter.
 *
 * Most of LM Studio's control surface is in its `lms` CLI rather than its HTTP
 * API, which is why this adapter shells out for anything that changes state and
 * only reads over HTTP. `lms server start` and `lms server stop` are a real
 * lifecycle, so LM Studio never needs the kill-the-PID-on-the-port fallback.
 *
 * All of that governs the LM Studio on *this* machine. A remote instance can be
 * read but not driven, which `detect` reports as `installed: false` with a reason
 * rather than offering a button that cannot work.
 */

/**
 * `lms ls --json`. The HTTP API publishes no size at all, so this is the only
 * source of a real weights figure for LM Studio, plus the sibling variants the
 * planner can suggest as a smaller build.
 */
interface LmsListEntry {
  type?: string;
  modelKey?: string;
  sizeBytes?: number;
  paramsString?: string;
  architecture?: string;
  quantization?: { name?: string; bits?: number };
  maxContextLength?: number;
  variants?: string[];
}

interface V0Model {
  id: string;
  state?: string;
  type?: string;
  arch?: string;
  quantization?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

// `lms load`/`unload` exit 0 even on some failures ("Model Not Found" among
// them), so success is exit-0 and the output not matching a failure phrase.
// Learned the hard way in T99; do not simplify this to an exit-code check.
const FAILURE_RE =
  /(model not found|cannot find a model|no models are|is not loaded|not connected|failed to|error:)/i;

const REMOTE_REASON =
  'This LM Studio looks remote. Starting, stopping, and loading need the lms CLI on the machine running it.';
const MISSING_REASON =
  "LM Studio's lms CLI was not found. Run `lms bootstrap` (or reinstall LM Studio) to manage it from here.";

export function createLmStudioAdapter(ctx: RuntimeContext): RuntimeAdapter {
  async function lms(args: string[], timeoutMs: number): Promise<{ ok: boolean; text: string }> {
    const out = await ctx.run(lmsBin(), args, timeoutMs);
    if (out === null) return { ok: false, text: '' };
    return { ok: !FAILURE_RE.test(out), text: out.trim() };
  }

  async function models(baseUrl: string): Promise<V0Model[]> {
    const json = await getJson<{ data?: V0Model[] }>(ctx, `${apiRoot(baseUrl)}/api/v0/models`, 6000);
    return json?.data ?? [];
  }

  /** On-disk catalogue, keyed by the same model key the HTTP API reports. */
  async function catalogue(baseUrl: string): Promise<Map<string, LmsListEntry>> {
    if (!isLocalhostUrl(baseUrl)) return new Map();
    const out = await ctx.run(lmsBin(), ['ls', '--json'], 10_000);
    if (!out) return new Map();
    try {
      const entries = JSON.parse(out.slice(out.indexOf('['))) as LmsListEntry[];
      return new Map(entries.filter((e) => e.modelKey).map((e) => [e.modelKey as string, e]));
    } catch {
      return new Map();
    }
  }

  return {
    kind: 'lmstudio',
    capabilities: RUNTIME_CAPABILITIES.lmstudio,

    async detect(baseUrl: string): Promise<RuntimeDetection> {
      const running = (await models(baseUrl)).length > 0 || (await getJson(ctx, `${trimUrl(baseUrl)}/models`, 2500)) !== null;
      if (!isLocalhostUrl(baseUrl)) {
        return { kind: 'lmstudio', running, installed: false, reason: REMOTE_REASON };
      }
      const version = await ctx.run(lmsBin(), ['version'], 4000);
      return version !== null
        ? { kind: 'lmstudio', running, installed: true, version: version.match(/(\d+\.\d+\.\d+)/)?.[1] }
        : { kind: 'lmstudio', running, installed: false, reason: MISSING_REASON };
    },

    async status(baseUrl: string): Promise<RuntimeStatus> {
      const detection = await this.detect(baseUrl);
      const resident: ResidentModel[] = (await models(baseUrl))
        .filter((m) => m.state === 'loaded')
        .map((m) => ({ id: m.id, contextLength: m.loaded_context_length }));
      return {
        kind: 'lmstudio',
        running: detection.running,
        installed: detection.installed,
        reason: detection.reason,
        owned: false,
        version: detection.version,
        baseUrl,
        resident,
      };
    },

    async listModels(baseUrl: string): Promise<ModelFacts[]> {
      const [live, disk] = await Promise.all([models(baseUrl), catalogue(baseUrl)]);
      return live.map((m) => toFacts(m, baseUrl, disk.get(m.id)));
    },

    async start(opts: StartOptions): Promise<RuntimeStatus> {
      const port = portOf(opts.baseUrl);
      const args = ['server', 'start'];
      if (port) args.push('--port', String(port));
      const res = await lms(args, 30_000);
      return {
        kind: 'lmstudio',
        running: res.ok,
        owned: false, // lms owns the process, not us
        baseUrl: opts.baseUrl,
        startedAt: res.ok ? Date.now() : undefined,
        resident: [],
        log: res.text ? res.text.split('\n').slice(-20) : undefined,
        error: res.ok ? undefined : res.text || 'lms server start failed.',
      };
    },

    async stop(baseUrl: string): Promise<StopResult> {
      if (!isLocalhostUrl(baseUrl)) return { ok: false, message: REMOTE_REASON };
      const res = await lms(['server', 'stop'], 15_000);
      return res.ok
        ? { ok: true, message: 'Stopped the LM Studio server.' }
        : { ok: false, message: res.text || "Couldn't stop the LM Studio server." };
    },

    async load(baseUrl: string, modelId: string, params: LoadParams): Promise<LoadResult> {
      if (!isLocalhostUrl(baseUrl)) return { ok: false, message: REMOTE_REASON };
      const args = ['load', modelId, '-y'];
      if (params.contextTokens) args.push('--context-length', String(params.contextTokens));

      // LM Studio takes a 0..1 share of layers, or max/off. The planner works in
      // layer counts, so convert using the model's own layer count when we have it.
      const gpu = await gpuFlag(params, () => this.listModels(baseUrl).then((m) => m.find((x) => x.id === modelId)));
      if (gpu) args.push('--gpu', gpu);
      if (params.ttlSeconds !== undefined) args.push('--ttl', String(params.ttlSeconds));

      // A large model can take minutes; killing the child would abort the load.
      const res = await lms(args, 300_000);
      return res.ok
        ? { ok: true, message: `Loaded ${modelId}` }
        : { ok: false, message: firstLines(res.text) || `Couldn't load ${modelId}.` };
    },

    async unload(baseUrl: string, modelId: string): Promise<LoadResult> {
      if (!isLocalhostUrl(baseUrl)) return { ok: false, message: REMOTE_REASON };
      const res = await lms(['unload', modelId], 15_000);
      return res.ok
        ? { ok: true, message: `Unloaded ${modelId}` }
        : { ok: false, message: firstLines(res.text) || `Couldn't unload ${modelId}.` };
    },
  };
}

async function gpuFlag(
  params: LoadParams,
  lookup: () => Promise<ModelFacts | undefined>,
): Promise<string | null> {
  if (params.gpuLayers === undefined) return null;
  if (params.gpuLayers === 0) return 'off';
  const facts = await lookup();
  if (!facts?.layers) return 'max';
  const share = Math.min(1, Math.max(0, params.gpuLayers / facts.layers));
  return share >= 0.999 ? 'max' : share.toFixed(2);
}

function toFacts(m: V0Model, baseUrl: string, disk?: LmsListEntry): ModelFacts {
  return {
    id: m.id,
    providerId: baseUrl,
    // The HTTP API publishes no size, so the weights figure comes from the CLI
    // catalogue. Layer geometry is available in neither, which is why an LM
    // Studio projection reports its KV cache as unknown rather than inventing
    // one: reading GGUF headers directly is phase C work.
    weightsBytes: disk?.sizeBytes,
    maxContext: m.max_context_length ?? disk?.maxContextLength ?? undefined,
    quantization: m.quantization ?? disk?.quantization?.name,
    parameterSize: disk?.paramsString,
    loaded: m.state === 'loaded',
    loadedContext: m.loaded_context_length ?? undefined,
  };
}

function firstLines(text: string): string {
  return text.split('\n').filter(Boolean).slice(0, 2).join('. ').slice(0, 240);
}

function portOf(baseUrl: string): number | null {
  try {
    const p = new URL(baseUrl).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}
