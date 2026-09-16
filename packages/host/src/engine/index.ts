import { join, resolve } from 'path';
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
      void downloads.start({
        id: `${jobId}:${extra}`,
        kind: 'model',
        label: `${model.name} · ${extra.split('/').pop()}`,
        target: modelId,
        url: hfFileUrl(modelId, extra),
        dest: destFor(extra),
      });
    }

    return { ok: true, message: `Downloading ${model.name} (${quant.label}).`, jobId: job.id };
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
    return {
      install,
      running: state.running,
      startedAt: state.startedAt,
      resident: state.resident,
      log: state.log,
      port: state.port,
      settings: deps.settings(),
    };
  }

  /** Every model in the library, with load state folded in. */
  async function models(): Promise<Array<LocalModel & { loaded: boolean }>> {
    const loaded = new Set(server.loadedIds());
    return (await library.list()).map((m) => ({ ...m, loaded: loaded.has(m.id) }));
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
export { buildArgs } from './server.js';
export { buildsFor, recommendedBuild, matchAsset, matchCompanion, allBuilds } from './builds.js';
export { hfFileUrl } from './catalog.js';
export type { EngineInstall, CatalogModel };
