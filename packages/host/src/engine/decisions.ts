import { readdir, rm, stat } from 'fs/promises';
import { join, resolve, sep } from 'path';
import type {
  DecisionCatalogEntry,
  DecisionPrecision,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  DecisionStatus,
  InstalledDecisionModel,
} from '@agent-nekko/shared';
import type { createDownloads } from './download.js';
import type { EngineDaemon } from './daemon.js';

/**
 * Decision models: classifiers that read a state and answer typed questions
 * (`choice`, `score`, `noul`) with calibrated probabilities in one forward
 * pass, instead of generating text.
 *
 * Two providers speak the same request and response (TypeSafe Jev's):
 * - **Local**: Laya, run natively by the engine daemon (`crates/nekko-decide`,
 *   ONNX Runtime on DirectML, CoreML or CUDA). The TS side only fetches its
 *   files and asks the daemon to load and run it, so there is no Python.
 * - **TypeSafe Jev**: the hosted model, reached with the user's API key.
 */

/** Pinned so a re-export upstream never swaps the weights under a user. */
const LAYA_ONNX = { repo: 'tozp/laya-onnx', revision: '0d1f7ebf46a3ea04ec4424df602f96ddefb66766' };

export const DECISION_CATALOG: DecisionCatalogEntry[] = [
  {
    id: 'laya-en',
    name: 'Laya (English)',
    publisher: 'Convai Innovations',
    license: 'Apache-2.0',
    source: `${LAYA_ONNX.repo}@${LAYA_ONNX.revision.slice(0, 7)}`,
    description:
      'A 395M ModernBERT decision model. Routes, scores and answers yes/no questions about a text or JSON state, with calibrated probabilities, in one pass. 512-token context.',
    variants: [
      { precision: 'fp16', file: 'model_fp16.onnx', bytes: 843_685_645, recommended: true },
      { precision: 'int8', file: 'model_int8.onnx', bytes: 424_348_081 },
      { precision: 'fp32', file: 'model.onnx', bytes: 1_685_917_998 },
    ],
    shared: [
      { file: 'tokenizer.json', bytes: 3_583_228 },
      { file: 'tokenizer_config.json', bytes: 308 },
      { file: 'rl_agent_config.json', bytes: 745 },
      { file: 'config.json', bytes: 2_083 },
    ],
  },
];

const TYPESAFE_URL = 'https://api.typesafe.ai/v1';
const MODEL_FILES: Record<DecisionPrecision, string[]> = {
  fp16: ['model_fp16.onnx', 'model.fp16.onnx', 'laya.fp16.onnx'],
  fp32: ['model.onnx', 'laya.onnx'],
  int8: ['model_int8.onnx', 'model.int8.onnx', 'laya.int8.onnx'],
};
const MAX_STATE_CHARS = 50_000;
const MAX_QUESTIONS = 64;

export interface DecisionsDeps {
  modelsDir: () => string;
  downloads: ReturnType<typeof createDownloads>;
  daemon: () => EngineDaemon | undefined;
  typesafeKey: () => string | undefined;
  fetch?: typeof fetch;
}

const fileSize = (path: string) => stat(path).then((s) => (s.isFile() ? s.size : 0)).catch(() => 0);

export function createDecisions(deps: DecisionsDeps) {
  const doFetch = deps.fetch ?? fetch;
  const root = () => join(deps.modelsDir(), 'decision');
  const dirOf = (id: string) => {
    const dir = resolve(root(), id);
    // Ids come from the renderer: never let one name a path outside the folder.
    if (!dir.startsWith(resolve(root()) + sep)) throw new Error('That is not a decision model id.');
    return dir;
  };

  async function models(): Promise<InstalledDecisionModel[]> {
    const names = await readdir(root()).catch(() => [] as string[]);
    const out: InstalledDecisionModel[] = [];
    for (const id of names) {
      const dir = join(root(), id);
      if (!(await fileSize(join(dir, 'rl_agent_config.json'))) || !(await fileSize(join(dir, 'tokenizer.json')))) continue;
      const precisions: DecisionPrecision[] = [];
      let sizeBytes = 0;
      for (const p of ['fp16', 'int8', 'fp32'] as const) {
        for (const f of MODEL_FILES[p]) {
          const size = await fileSize(join(dir, f));
          if (size) { precisions.push(p); sizeBytes += size; break; }
        }
      }
      if (!precisions.length) continue;
      const entry = DECISION_CATALOG.find((c) => c.id === id);
      out.push({ id, name: entry?.name ?? id, dir, precisions, sizeBytes, catalogId: entry?.id });
    }
    return out;
  }

  /** Fetch one precision of a catalog model, plus its tokenizer and config. */
  async function download(catalogId: string, precision: DecisionPrecision = 'fp16'): Promise<{ ok: boolean; message: string }> {
    const entry = DECISION_CATALOG.find((c) => c.id === catalogId);
    const variant = entry?.variants.find((v) => v.precision === precision);
    if (!entry || !variant) return { ok: false, message: 'That decision model is not in the catalog.' };
    const dir = dirOf(entry.id);
    let queued = 0;
    let bytes = 0;
    for (const f of [...entry.shared, variant]) {
      const dest = join(dir, f.file);
      if ((await fileSize(dest)) === f.bytes) continue;
      void deps.downloads.start({
        id: `decision:${entry.id}:${f.file}`,
        kind: 'model',
        label: `${entry.name} · ${f.file}`,
        target: entry.id,
        url: `https://huggingface.co/${LAYA_ONNX.repo}/resolve/${LAYA_ONNX.revision}/${f.file}?download=true`,
        dest,
        verify: async (part) => ((await fileSize(part)) === f.bytes ? null : `${f.file} is not the published size.`),
      });
      queued += 1;
      bytes += f.bytes;
    }
    return queued
      ? { ok: true, message: `Downloading ${entry.name} ${precision} (${(bytes / 1e9).toFixed(2)} GB).` }
      : { ok: true, message: `${entry.name} ${precision} is already downloaded.` };
  }

  async function remove(id: string): Promise<{ ok: boolean; message: string }> {
    const dir = dirOf(id);
    const daemon = deps.daemon();
    const loaded = daemon ? await daemon.decideStatus().catch(() => null) : null;
    if (loaded?.loaded && loaded.dir && resolve(String(loaded.dir)) === dir) await daemon?.decideUnload();
    await rm(dir, { recursive: true, force: true });
    return { ok: true, message: 'Deleted the decision model.' };
  }

  async function status(): Promise<DecisionStatus> {
    const daemon = deps.daemon();
    const typesafe = { configured: Boolean(deps.typesafeKey()) };
    if (!daemon) {
      return { local: { available: false, loaded: false, reason: 'Local decision models run in the desktop app\'s engine daemon.' }, typesafe };
    }
    const s = await daemon.decideStatus().catch((e: Error) => ({ loaded: false, error: e.message }) as Record<string, unknown>);
    return {
      local: {
        available: true,
        loaded: Boolean(s.loaded),
        model: s.model as string | undefined,
        dir: s.dir as string | undefined,
        ep: s.ep as string | undefined,
        precision: s.precision as DecisionPrecision | undefined,
        loadMs: s.loadMs as number | undefined,
        reason: s.error as string | undefined,
      },
      typesafe,
    };
  }

  async function load(id: string, precision?: DecisionPrecision): Promise<{ ok: boolean; message: string }> {
    const daemon = deps.daemon();
    if (!daemon) return { ok: false, message: 'Local decision models run in the desktop app\'s engine daemon.' };
    const model = (await models()).find((m) => m.id === id);
    if (!model) return { ok: false, message: 'That decision model is not downloaded.' };
    try {
      const s = await daemon.decideLoad({ dir: model.dir, precision: precision ?? model.precisions[0], name: model.id });
      return { ok: true, message: `Loaded ${model.name} (${s.precision ?? precision ?? model.precisions[0]}) on ${s.ep ?? 'the CPU'}${s.loadMs ? ` in ${(Number(s.loadMs) / 1000).toFixed(1)} s` : ''}.` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  async function unload(): Promise<{ ok: boolean; message: string }> {
    const daemon = deps.daemon();
    if (daemon) await daemon.decideUnload();
    return { ok: true, message: 'Unloaded the decision model.' };
  }

  /** The request shape both providers share; checked here so neither sees garbage. */
  function check(request: DecisionRequest): string | null {
    if (!request || typeof request !== 'object') return 'Send a state and at least one question.';
    const state = typeof request.state === 'string' ? request.state : JSON.stringify(request.state ?? '');
    if (!state.trim()) return 'The state is empty.';
    if (state.length > MAX_STATE_CHARS) return `The state is over ${MAX_STATE_CHARS.toLocaleString('en-US')} characters.`;
    const questions = request.questions && typeof request.questions === 'object' ? Object.keys(request.questions) : [];
    if (!questions.length) return 'Ask at least one question.';
    if (questions.length > MAX_QUESTIONS) return `Ask at most ${MAX_QUESTIONS} questions at once.`;
    return null;
  }

  async function run(provider: DecisionProvider, request: DecisionRequest): Promise<DecisionResponse> {
    const problem = check(request);
    if (problem) throw new Error(problem);
    const started = Date.now();
    if (provider === 'local') {
      const daemon = deps.daemon();
      if (!daemon) throw new Error('Local decision models run in the desktop app\'s engine daemon.');
      const res = await daemon.decideRun(request);
      return { ...res, provider: 'local', latencyMs: Date.now() - started };
    }
    const key = deps.typesafeKey();
    if (!key) throw new Error('Add a TypeSafe API key to use Jev.');
    const res = await doFetch(`${TYPESAFE_URL}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, model: request.model || 'jev-latest' }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* reported below */ }
    if (!res.ok) {
      const message = (body as { error?: { message?: string } | string } | null)?.error;
      throw new Error(`TypeSafe answered ${res.status}: ${typeof message === 'string' ? message : message?.message ?? text.slice(0, 200)}`);
    }
    return { ...(body as DecisionResponse), provider: 'typesafe', latencyMs: Date.now() - started };
  }

  /** A key check that costs nothing: TypeSafe's model list. */
  async function checkTypesafe(): Promise<{ ok: boolean; message: string }> {
    const key = deps.typesafeKey();
    if (!key) return { ok: false, message: 'No TypeSafe API key is set.' };
    const res = await doFetch(`${TYPESAFE_URL}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
    if (res instanceof Error) return { ok: false, message: `Could not reach TypeSafe: ${res.message}` };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'TypeSafe rejected the key.' };
    if (!res.ok) return { ok: false, message: `TypeSafe answered ${res.status}.` };
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
    const ids = body?.data?.map((m) => m.id) ?? [];
    return { ok: true, message: ids.length ? `Key works. Models: ${ids.join(', ')}.` : 'Key works.' };
  }

  return { catalog: async () => DECISION_CATALOG, models, download, remove, status, load, unload, run, checkTypesafe };
}
