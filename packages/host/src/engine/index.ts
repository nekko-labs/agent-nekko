import { totalmem } from 'os';
import { dirname, join, resolve } from 'path';
import { stat } from 'fs/promises';
import type {
  CatalogModel,
  CatalogModelDetail,
  DownloadJob,
  EngineInstall,
  EngineLoadPreset,
  EngineSettings,
  GpuStats,
  LoadParams,
  LoadResult,
  LocalModel,
  ModelFolder,
  ModelFolderReport,
  ModelFolderSuggestion,
  StopResult,
} from '@agent-nekko/shared';
import { DEFAULT_ENGINE_SETTINGS, engineBaseUrl } from '@agent-nekko/shared';
import { createCatalog, hfFileUrl } from './catalog.js';
import { companionsDir } from './companions.js';
import { createDownloads } from './download.js';
import { knownFolder, knownFolderCandidates } from './folders.js';
import { createEngineInstaller } from './install.js';
import { createLibrary, PRIMARY_FOLDER_ID } from './library.js';
import { createEngineServer } from './server.js';

/**
 * The engine, as one object.
 *
 * Four parts that only make sense together: acquire the engine, acquire models,
 * keep them on disk, serve them. Everything above this (the runtime adapter, IPC,
 * the renderer) talks to this facade rather than to the parts, so the split
 * between them can change without a channel changing.
 */

export interface EngineDeps {
  dataDir: () => string;
  getGpuStats: () => Promise<GpuStats | null>;
  /**
   * A reading taken now rather than from the poll cache. The before/after pair
   * around a load is a measurement, and a cached "after" can report that loading
   * a model took nothing.
   */
  getGpuStatsFresh?: () => Promise<GpuStats | null>;
  settings: () => EngineSettings;
  /** Persist a settings change (port, TTL, key). */
  saveSettings: (patch: Partial<EngineSettings>) => Promise<EngineSettings>;
  onDownloadsChanged?: (jobs: DownloadJob[]) => void;
  /**
   * Called with the engine's address whenever it starts serving, so the host can
   * keep a provider entry pointing at it. Without this the engine would run and
   * no chat could pick a model from it, which is the whole point of running it.
   */
  onServing?: (baseUrl: string) => void;
  /** Hugging Face token for gated repos, when the user has configured one. */
  hfToken?: () => string | undefined;
  /** A `llama-server` the user pointed at by hand. */
  externalBinPath?: () => string | undefined;
}

export function createEngine(deps: EngineDeps) {
  const modelsDir = () => deps.settings().modelsDir || join(deps.dataDir(), 'models');
  const engineDir = () => join(deps.dataDir(), 'engine');

  const downloads = createDownloads({ onChange: deps.onDownloadsChanged });
  const library = createLibrary({ modelsDir, folders: () => deps.settings().modelFolders ?? [] });
  const catalog = createCatalog({ token: deps.hfToken });
  const installer = createEngineInstaller({
    engineDir,
    downloads,
    getGpuStats: deps.getGpuStats,
    externalPath: deps.externalBinPath,
  });

  const server = createEngineServer({
    settings: deps.settings,
    binPath: async () => (await installer.detect()).binPath,
    findModel: (id) => library.find(id),
    listModels: () => library.list(),
    getGpuStats: deps.getGpuStatsFresh ?? deps.getGpuStats,
    workDir: () => join(engineDir(), 'templates'),
    companionsDir: (modelId) => companionsDir(modelsDir(), modelId),
  });

  /* ------------------------------------------------------------ acquisition */

  /**
   * Download one quantization of one catalog model.
   *
   * Companion files (later shards, a vision projector) are queued behind the main
   * file rather than in parallel: a split model is unusable until every shard has
   * landed, so finishing one at a time is both simpler to report and kinder to a
   * shared connection.
   */
  async function downloadModel(
    modelId: string,
    quantLabel: string,
  ): Promise<{ ok: boolean; message: string; jobId?: string }> {
    const model = await catalog.model(modelId);
    const quant = model?.quants.find((q) => q.label === quantLabel) ?? model?.quants[0];
    if (!model || !quant) return { ok: false, message: 'That model is no longer published.' };

    const destFor = (file: string) => join(modelsDir(), modelId.replace('/', '_'), file.split('/').pop() as string);
    const jobId = `model:${modelId}:${quant.label}`;

    const job = await downloads.start({
      id: jobId,
      kind: 'model',
      label: `${model.name} · ${quant.label}`,
      target: modelId,
      url: hfFileUrl(modelId, quant.file),
      dest: destFor(quant.file),
      verify: async (path) => {
        // A GGUF that will not parse is a failed download wearing the right
        // extension, and catching it here means the library never lists one.
        const { readGgufMetadata } = await import('./gguf.js');
        return (await readGgufMetadata(path)) ? null : 'The downloaded file is not a readable GGUF.';
      },
    });

    for (const extra of quant.extraFiles ?? []) {
      const dest = destFor(extra);
      // Sidecars are shared across quants; one already on disk is not fetched
      // again when a second build of the same repo is downloaded.
      const landed = await stat(dest).then((s) => s.size > 0).catch(() => false);
      if (landed) continue;
      void downloads.start({
        id: `${jobId}:${extra}`,
        kind: 'model',
        label: `${model.name} · ${extra.split('/').pop()}`,
        target: modelId,
        url: hfFileUrl(modelId, extra),
        dest,
      });
    }

    return { ok: true, message: `Downloading ${model.name} (${quant.label}).`, jobId: job.id };
  }

  /**
   * Fetch the files a model already on disk is missing: a vision projector
   * first, then the small configs its repo ships.
   *
   * This is the fix for the weights arriving without them (a manual download,
   * a file copied out of another app). Managed models get the files beside the
   * weights, where any tool can see them; a borrowed folder is read-only, so
   * the files land in the nekko-owned companions dir the server also reads.
   */
  async function downloadCompanions(modelId: string): Promise<{ ok: boolean; message: string }> {
    const model = await library.find(modelId);
    if (!model) return { ok: false, message: 'That model is not in the library.' };
    const repo = sourceRepoFor(model);
    if (!repo) {
      return {
        ok: false,
        message: `Cannot tell which Hugging Face repo ${model.name} came from, so there is nowhere to fetch its companion files from.`,
      };
    }
    const found = await catalog.companions(repo);
    if (!found) {
      return { ok: false, message: `Could not read the ${repo} repo on Hugging Face. It may be private or renamed.` };
    }

    const wanted = [found.projector, ...found.sidecars].filter((f): f is string => Boolean(f));
    if (!wanted.length) {
      return { ok: true, message: `${repo} ships no companion files for ${model.name}.` };
    }
    const destDir = model.managed === false ? companionsDir(modelsDir(), model.id) : dirname(model.path);
    let queued = 0;
    for (const file of wanted) {
      const fileName = file.split('/').pop() as string;
      const dest = join(destDir, fileName);
      const landed = await stat(dest).then((s) => s.size > 0).catch(() => false);
      // A file already beside the weights counts even when the destination is
      // the companions dir: no point fetching what is already there.
      const beside = join(dirname(model.path), fileName);
      const already = landed || (dest !== beside && (await stat(beside).then((s) => s.size > 0).catch(() => false)));
      if (already) continue;
      void downloads.start({
        id: `companions:${modelId}:${file}`,
        kind: 'model',
        label: `${model.name} · ${fileName}`,
        target: modelId,
        url: hfFileUrl(repo, file),
        dest,
      });
      queued += 1;
    }
    return queued
      ? { ok: true, message: `Fetching ${queued} companion file${queued === 1 ? '' : 's'} for ${model.name} from ${repo}.` }
      : { ok: true, message: `${model.name} already has every companion file ${repo} ships.` };
  }

  /**
   * Which Hugging Face repo a library model came from, guessed from its id.
   *
   * A borrowed folder nests `publisher/repo/file` under the folder id
   * (`lmstudio/unsloth/Qwen3-4B/file`), so the repo is the middle two segments.
   * Our own downloads land in a dir named `owner_repo` (the single `_` the
   * download path writes), so the first segment splits on its first `_`.
   * Anything else (a loose import, an id a folder provider invented) returns
   * undefined, which the caller turns into an honest "cannot tell" answer.
   */
  function sourceRepoFor(model: LocalModel): string | undefined {
    if (model.sourceRepo) return model.sourceRepo;
    const segs = model.id.split('/');
    if (model.folderId && model.folderId !== 'primary' && segs.length >= 3) {
      return `${segs[1]}/${segs[2]}`;
    }
    if ((!model.folderId || model.folderId === 'primary') && segs.length >= 2) {
      const dir = segs[0];
      const i = dir.indexOf('_');
      if (i > 0 && i < dir.length - 1) return `${dir.slice(0, i)}/${dir.slice(i + 1)}`;
    }
    return undefined;
  }

  /* --------------------------------------------------------- model folders */

  /**
   * The folder list, plus the known layouts on this machine nobody has added.
   *
   * Suggestions are probed rather than merely tested for existence, because an
   * empty Ollama folder is not worth a row and "LM Studio (0 models)" is an
   * invitation to wonder what went wrong.
   */
  async function folders(): Promise<ModelFolderReport> {
    const configured = await library.folderReport();
    const taken = new Set(configured.map((f) => resolve(f.path).toLowerCase()));

    const suggestions: ModelFolderSuggestion[] = [];
    for (const candidate of knownFolderCandidates()) {
      for (const path of candidate.paths) {
        if (taken.has(resolve(path).toLowerCase())) continue;
        const found = await library.probe(path, candidate.provider);
        if (found.modelCount === 0) continue;
        taken.add(resolve(path).toLowerCase());
        suggestions.push({ provider: candidate.provider, path, ...found });
        break; // One row per app: the first of its candidate paths that has models.
      }
    }
    return { folders: configured, suggestions };
  }

  /** Replace the folder list. The primary folder is not in it and never moves here. */
  async function saveFolders(next: ModelFolder[]): Promise<ModelFolderReport> {
    await deps.saveSettings({ modelFolders: next.filter((f) => f.id !== PRIMARY_FOLDER_ID) });
    return folders();
  }

  /**
   * Adopt every known folder on this machine that has models in it.
   *
   * Run once, the first time the engine starts with no folder list at all, so a
   * machine that already has models through Ollama or LM Studio shows them
   * without anybody having to know this screen exists. Everything it adds stays
   * editable and switchable off, and it never runs again: a folder removed on
   * purpose should stay removed.
   */
  async function seedFolders(): Promise<void> {
    if (deps.settings().modelFolders !== undefined) return;
    const found: ModelFolder[] = [];
    const taken = new Set([resolve(modelsDir()).toLowerCase()]);
    for (const candidate of knownFolderCandidates()) {
      for (const path of candidate.paths) {
        const key = resolve(path).toLowerCase();
        if (taken.has(key)) continue;
        if ((await library.probe(path, candidate.provider)).modelCount === 0) continue;
        taken.add(key);
        found.push(knownFolder(candidate.provider, path));
        break;
      }
    }
    await deps.saveSettings({ modelFolders: found });
  }

  /* --------------------------------------------------------------- serving */

  async function load(modelId: string, params: LoadParams): Promise<LoadResult> {
    // Loading is the moment a user expects the engine to be up, so starting it
    // here beats making them press two buttons in the right order.
    if (!server.isRunning()) {
      const started = await start();
      if (!started.ok) return { ok: false, message: started.message };
    }
    return server.load(modelId, params);
  }

  async function status() {
    const install = await installer.detect();
    const state = server.status();
    const gpu = await deps.getGpuStats().catch(() => null);
    // What the "will it fit" chips compare against: VRAM when there is a GPU to
    // name, system RAM otherwise. Total, not free: the question is whether the
    // model can ever be served here, not whether it fits beside open apps.
    const memory = gpu && gpu.devices.length > 0
      ? { budgetBytes: gpu.totalMB * 1024 * 1024, kind: gpu.unified ? ('unified' as const) : ('vram' as const) }
      : { budgetBytes: totalmem(), kind: 'ram' as const };
    return {
      install,
      running: state.running,
      startedAt: state.startedAt,
      resident: state.resident,
      log: state.log,
      port: state.port,
      settings: deps.settings(),
      memory,
    };
  }

  /** Every model in the library, with load state and the last failure folded in. */
  async function models(): Promise<Array<LocalModel & { loaded: boolean }>> {
    const loaded = new Set(server.loadedIds());
    return (await library.list()).map((m) => ({
      ...m,
      loaded: loaded.has(m.id),
      lastLoadError: server.loadErrorFor(m.id),
    }));
  }

  async function start(): Promise<{ ok: boolean; message: string }> {
    const res = await server.start();
    if (res.ok) deps.onServing?.(engineBaseUrl(deps.settings()));
    return res;
  }

  return {
    // engine binary
    detectEngine: () => installer.detect(),
    installEngine: (buildId?: string) => installer.install(buildId),
    uninstallEngine: () => installer.uninstall(),
    // catalog + downloads
    catalogCurated: () => catalog.curated(),
    catalogSearch: (q: string) => catalog.search(q),
    catalogModel: (id: string) => catalog.model(id),
    catalogDetail: (id: string): Promise<CatalogModelDetail | null> => catalog.detail(id),
    downloadModel,
    downloadCompanions,
    downloads: () => downloads.list(),
    cancelDownload: (id: string) => downloads.cancel(id),
    dismissDownload: (id: string) => downloads.dismiss(id),
    // library
    models,
    findModel: (id: string) => library.find(id),
    importModel: (path: string) => library.importFile(path),
    deleteModel: (id: string) => library.remove(id),
    saveModelPreset: (id: string, preset: EngineLoadPreset) => library.savePreset(id, preset),
    diskUsage: () => library.diskUsage(),
    // model folders
    folders,
    saveFolders,
    seedFolders,
    // server
    start,
    stop: (): Promise<StopResult> => server.stop(),
    load,
    unload: (id: string) => server.unload(id),
    setResidentTtl: (id: string, ttlSeconds: number) => {
      const r = server.setResidentTtl(id, ttlSeconds);
      return { ok: r.ok, message: r.message ?? '' };
    },
    /** Add or remove a model from the list loaded when the engine starts. */
    setAutoload: (id: string, enabled: boolean) => {
      const current = deps.settings().autoload ?? [];
      const next = enabled ? [...new Set([...current, id])] : current.filter((m) => m !== id);
      return deps.saveSettings({ autoload: next });
    },
    status,
    isRunning: () => server.isRunning(),
    resident: () => server.resident(),
    saveSettings: async (patch: Partial<EngineSettings>) => {
      const next = await deps.saveSettings(patch);
      // The port and the binding are read when the socket is opened, so a change
      // to either only takes effect on the next start. Restarting here rather
      // than leaving the UI to explain that is the honest behaviour.
      if (server.isRunning() && (patch.port !== undefined || patch.bind !== undefined)) {
        await server.stop();
        await start();
      }
      return next;
    },
    defaults: DEFAULT_ENGINE_SETTINGS,
  };
}

export type Engine = ReturnType<typeof createEngine>;

export { readGgufMetadata } from './gguf.js';
export { buildArgs, explainLoadError } from './server.js';
export type { ModelCompanions } from './server.js';
export { buildsFor, recommendedBuild, matchAsset, matchCompanion, allBuilds } from './builds.js';
export { hfFileUrl } from './catalog.js';
export type { EngineInstall, CatalogModel };
