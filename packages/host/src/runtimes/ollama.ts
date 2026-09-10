import {
  RUNTIME_CAPABILITIES,
  type LoadParams,
  type LoadResult,
  type ModelFacts,
  type ResidentModel,
  type RuntimeDetection,
  type RuntimeStatus,
  type StopResult,
} from '@agent-nekko/shared';
import { headDimOf } from '@agent-nekko/core';
import { apiRoot, getJson, postJson, type RuntimeAdapter, type RuntimeContext } from './types.js';

/**
 * Ollama adapter.
 *
 * The most controllable of the three over plain HTTP, and the only one that
 * reports its own CPU spill: `/api/ps` gives both `size` and `size_vram`, and the
 * gap between them is exactly what did not fit on the GPU.
 *
 * `/api/show` is what makes an accurate projection possible at all. Its
 * `model_info` map carries the block count, KV head count, and embedding length,
 * which are the three numbers the KV-cache formula needs. Nothing else we talk to
 * publishes them.
 */

interface PsEntry {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
  context_length?: number;
  expires_at?: string;
  details?: { parameter_size?: string; quantization_level?: string };
}

interface ShowResponse {
  details?: { parameter_size?: string; quantization_level?: string };
  model_info?: Record<string, unknown>;
}

/** `/api/show` results change only when a model is re-pulled. */
const SHOW_TTL_MS = 60_000;
/** A 40-model library would otherwise fire 40 requests on every 6s poll. */
const SHOW_CONCURRENCY = 4;

export function createOllamaAdapter(ctx: RuntimeContext): RuntimeAdapter {
  const showCache = new Map<string, { at: number; value: ShowResponse | null }>();

  async function show(baseUrl: string, model: string): Promise<ShowResponse | null> {
    const key = `${baseUrl}::${model}`;
    const hit = showCache.get(key);
    if (hit && Date.now() - hit.at < SHOW_TTL_MS) return hit.value;
    const res = await postJson(ctx, `${apiRoot(baseUrl)}/api/show`, { model }, 6000);
    let value: ShowResponse | null = null;
    if (res?.ok) {
      try {
        value = (await res.json()) as ShowResponse;
      } catch {
        value = null;
      }
    }
    showCache.set(key, { at: Date.now(), value });
    return value;
  }

  async function ps(baseUrl: string): Promise<PsEntry[]> {
    const json = await getJson<{ models?: PsEntry[] }>(ctx, `${apiRoot(baseUrl)}/api/ps`);
    return json?.models ?? [];
  }

  return {
    kind: 'ollama',
    capabilities: RUNTIME_CAPABILITIES.ollama,

    async detect(baseUrl: string): Promise<RuntimeDetection> {
      const version = await getJson<{ version?: string }>(ctx, `${apiRoot(baseUrl)}/api/version`, 2500);
      if (version) {
        return { kind: 'ollama', running: true, installed: true, version: version.version };
      }
      // Not answering. It may still be installed, in which case we can start it.
      const out = await ctx.run('ollama', ['--version'], 4000);
      return out !== null
        ? { kind: 'ollama', running: false, installed: true, version: parseCliVersion(out) }
        : {
            kind: 'ollama',
            running: false,
            installed: false,
            reason: 'Ollama was not found on this machine. Install it from ollama.com, then start it here.',
          };
    },

    async status(baseUrl: string): Promise<RuntimeStatus> {
      const detection = await this.detect(baseUrl);
      const resident: ResidentModel[] = detection.running
        ? (await ps(baseUrl)).map(toResident)
        : [];
      return {
        kind: 'ollama',
        running: detection.running,
        installed: detection.installed,
        reason: detection.reason,
        owned: false, // the supervisor overrides this for processes it started
        version: detection.version,
        baseUrl,
        resident,
      };
    },

    async listModels(baseUrl: string): Promise<ModelFacts[]> {
      const root = apiRoot(baseUrl);
      const tags = await getJson<{ models?: Array<{ name?: string; model?: string; size?: number }> }>(
        ctx,
        `${root}/api/tags`,
        6000,
      );
      const names = (tags?.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
      const sizes = new Map(
        (tags?.models ?? []).map((m) => [m.name ?? m.model ?? '', m.size]),
      );
      const running = new Map((await ps(baseUrl)).map((e) => [e.name ?? e.model ?? '', e]));

      const out: ModelFacts[] = [];
      for (const batch of chunk(names, SHOW_CONCURRENCY)) {
        const detail = await Promise.all(batch.map((n) => show(baseUrl, n)));
        batch.forEach((name, i) => {
          const live = running.get(name);
          out.push(toFacts(name, baseUrl, detail[i], live, sizes.get(name)));
        });
      }
      return out;
    },

    async load(baseUrl: string, modelId: string, params: LoadParams): Promise<LoadResult> {
      // Ollama loads a model by being asked to generate nothing with it. The
      // options ride along, which is how context and layer count are set.
      const options: Record<string, number> = {};
      if (params.contextTokens) options.num_ctx = params.contextTokens;
      if (params.gpuLayers !== undefined) options.num_gpu = params.gpuLayers;
      const body: Record<string, unknown> = { model: modelId, prompt: '', options };
      if (params.ttlSeconds !== undefined) body.keep_alive = `${params.ttlSeconds}s`;

      // A cold load of a large model off a slow disk is genuinely slow.
      const res = await postJson(ctx, `${apiRoot(baseUrl)}/api/generate`, body, 300_000);
      if (!res?.ok) {
        return { ok: false, message: res ? `Ollama refused the load (HTTP ${res.status}).` : 'Ollama did not respond.' };
      }
      return { ok: true, message: `Loaded ${modelId}` };
    },

    async unload(baseUrl: string, modelId: string): Promise<LoadResult> {
      // keep_alive 0 evicts it immediately.
      const res = await postJson(
        ctx,
        `${apiRoot(baseUrl)}/api/generate`,
        { model: modelId, prompt: '', keep_alive: 0 },
        15_000,
      );
      return res?.ok
        ? { ok: true, message: `Unloaded ${modelId}` }
        : { ok: false, message: `Couldn't unload ${modelId}.` };
    },

    async stop(): Promise<StopResult> {
      // Stopping is process work, so the supervisor owns it. This exists to
      // declare the capability; index.ts routes the call.
      return { ok: false, message: 'Stopping is handled by the supervisor.' };
    },
  };
}

function toResident(e: PsEntry): ResidentModel {
  return {
    id: e.name ?? e.model ?? '',
    sizeBytes: e.size,
    vramBytes: e.size_vram,
    contextLength: e.context_length,
    expiresAt: e.expires_at ? Date.parse(e.expires_at) || undefined : undefined,
  };
}

function toFacts(
  name: string,
  providerBase: string,
  detail: ShowResponse | null,
  live: PsEntry | undefined,
  diskSize: number | undefined,
): ModelFacts {
  const info = detail?.model_info ?? {};
  const layers = infoNumber(info, 'block_count');
  const kvHeads = infoNumber(info, 'attention.head_count_kv');
  const heads = infoNumber(info, 'attention.head_count');
  const embedding = infoNumber(info, 'embedding_length');
  return {
    id: name,
    providerId: providerBase,
    // The resident size is the truest number available; disk size is the fallback.
    weightsBytes: live?.size ?? diskSize,
    layers,
    kvHeads: kvHeads ?? heads,
    headDim: headDimOf(embedding, heads),
    maxContext: infoNumber(info, 'context_length'),
    quantization: detail?.details?.quantization_level ?? live?.details?.quantization_level,
    parameterSize: detail?.details?.parameter_size ?? live?.details?.parameter_size,
    loaded: Boolean(live),
    vramBytes: live?.size_vram,
    loadedContext: live?.context_length,
  };
}

/**
 * `model_info` keys are architecture-prefixed: `llama.block_count`,
 * `qwen3.attention.head_count_kv`, `gemma2.embedding_length`. Matching on the
 * suffix rather than a known prefix means a new architecture needs no change here.
 */
function infoNumber(info: Record<string, unknown>, suffix: string): number | undefined {
  for (const [key, value] of Object.entries(info)) {
    if (key === suffix || key.endsWith(`.${suffix}`)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

function parseCliVersion(out: string): string | undefined {
  return out.match(/(\d+\.\d+\.\d+)/)?.[1];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
