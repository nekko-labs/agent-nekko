/**
 * The Nekko engine: the model server Agent Nekko runs itself.
 *
 * Everything else in `runtimes.ts` describes a server somebody else installed.
 * This file describes the one we own, which needs three things the others do not:
 * a way to acquire the engine binary, a way to acquire models, and a server
 * configuration of its own (port, binding, key) because there is no other app to
 * configure it in.
 *
 * The engine is `llama.cpp`'s `llama-server`, one child process per loaded model,
 * behind a router that presents them all on one OpenAI-compatible address. That
 * shape is what lets several models be resident at once, which is the difference
 * between a wrapper and a model server.
 */

import type { KvCacheDtype } from './capacity.js';
import type { ResidentModel } from './runtimes.js';

/** Where an engine binary came from. */
export type EngineSource = 'managed' | 'external';

/**
 * The platforms llama.cpp publishes builds for. A string union rather than
 * `NodeJS.Platform` because this package is shared with the renderer, which has
 * no Node types and must not grow a dependency on them.
 */
export type EnginePlatform = 'win32' | 'darwin' | 'linux';

/** The acceleration backend a build was compiled for. */
export type EngineBackend = 'cuda' | 'metal' | 'vulkan' | 'hip' | 'cpu';

export const ENGINE_BACKEND_LABELS: Record<EngineBackend, string> = {
  cuda: 'NVIDIA (CUDA)',
  metal: 'Apple (Metal)',
  vulkan: 'Vulkan',
  hip: 'AMD (ROCm/HIP)',
  cpu: 'CPU only',
};

/**
 * One downloadable llama.cpp build.
 *
 * `assetPattern` is matched against a release's asset names rather than being a
 * fixed filename, because llama.cpp's asset names carry the build number
 * (`llama-b7021-bin-win-cuda-x64.zip`) and pinning a filename would mean pinning
 * a build forever.
 */
export interface EngineBuild {
  id: string;
  platform: EnginePlatform;
  arch: string;
  backend: EngineBackend;
  /** Matched against release asset names, most specific first. */
  assetPattern: string;
  /** Human sentence for the picker: what hardware this build is for. */
  requires: string;
  /** Extra runtime libraries this build needs alongside the main archive. */
  companionPattern?: string;
}

/** What we know about the engine on this machine right now. */
export interface EngineInstall {
  /** Absolute path to `llama-server`, when one is usable. */
  binPath?: string;
  source?: EngineSource;
  backend?: EngineBackend;
  /** llama.cpp build tag, e.g. `b7021`. */
  version?: string;
  installedAt?: number;
  /** Why no engine is usable, when `binPath` is absent. */
  reason?: string;
  /** Builds offered for this machine, best first. */
  available: EngineBuild[];
  /** The build we would install if asked, from the hardware probe. */
  recommended?: EngineBuild;
}

/**
 * The engine's own server configuration, which for every other runtime lives in
 * that runtime's app. Defaults are deliberately the safe ones: loopback only, no
 * key needed, nothing started until asked.
 */
export interface EngineSettings {
  port: number;
  /** `local` binds 127.0.0.1; `lan` binds 0.0.0.0 and is a deliberate act. */
  bind: 'local' | 'lan';
  /** Required as a Bearer token when set. Empty means no auth, which is fine on loopback. */
  apiKey?: string;
  /** Allowed browser origins. `*` is permitted but never the default. */
  corsOrigins?: string;
  /** Start the router when Agent Nekko starts. */
  autoStart: boolean;
  /** Load a model on first request rather than making the user load it first. */
  jitLoad: boolean;
  /** Evict a model after this many idle seconds. 0 keeps it resident. */
  idleTtlSeconds: number;
  /** How many models may be resident at once. */
  maxLoaded: number;
  /** Where GGUF files live. Defaults to `<dataDir>/models`. */
  modelsDir?: string;
  /**
   * Extra folders to look in, beyond the one downloads land in.
   *
   * A list rather than a second path because the models on a machine are
   * usually spread over several apps' folders at once, and because a folder
   * someone stops using should be switchable off without being retyped later.
   */
  modelFolders?: ModelFolder[];
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  port: 11500,
  bind: 'local',
  autoStart: false,
  jitLoad: true,
  idleTtlSeconds: 900,
  maxLoaded: 2,
};

/** The engine's base URL for a given configuration. */
export function engineBaseUrl(settings: Pick<EngineSettings, 'port'>): string {
  return `http://127.0.0.1:${settings.port}/v1`;
}

/** Everything the engine card needs in one read. */
export interface EngineStatus {
  install: EngineInstall;
  running: boolean;
  startedAt?: number;
  resident: ResidentModel[];
  /** Recent router and child-process output, newest last. */
  log: string[];
  port: number;
  settings: EngineSettings;
}

/**
 * The simple surface's only control: how much of this machine the model may use.
 *
 * It is a fraction rather than three named presets because it feeds the planner
 * as a number, and because the honest answer to "will 70% work" depends on the
 * machine, not on a label.
 */
export interface MachineBudget {
  /** 0..1 of free memory the model may occupy. */
  fraction: number;
}

export const BUDGET_PRESETS: Array<{ id: string; label: string; fraction: number; hint: string }> = [
  { id: 'gentle', label: 'Leave my machine usable', fraction: 0.5, hint: 'Other apps stay responsive.' },
  { id: 'balanced', label: 'Balanced', fraction: 0.75, hint: 'Most of the memory, some left over.' },
  { id: 'full', label: 'Everything it has', fraction: 0.92, hint: 'Fastest, expect stutter elsewhere.' },
];

/* ------------------------------------------------------------------ catalog */

/** One quantization of one model: the thing actually downloaded. */
export interface CatalogQuant {
  /** e.g. `Q4_K_M`. */
  label: string;
  /** Repo-relative file name. */
  file: string;
  sizeBytes?: number;
  /** Extra files the model needs (a multimodal projector, split shards). */
  extraFiles?: string[];
  /** Short note for the picker, e.g. "best balance of size and quality". */
  note?: string;
}

/** A model as offered for download, before it exists on disk. */
export interface CatalogModel {
  /** Stable id: `<owner>/<repo>` on Hugging Face. */
  id: string;
  name: string;
  /** Publisher handle, for the "who made this" line. */
  owner: string;
  parameterSize?: string;
  /** One line about what this model is for. */
  summary?: string;
  /** Curated capability tags: `chat`, `code`, `reasoning`, `vision`, `embedding`, `tools`. */
  tags: string[];
  quants: CatalogQuant[];
  downloads?: number;
  /** Set on curated entries so the starter list can be shown before any search. */
  curated?: boolean;
  /** License id when the repo declares one, so a gated model can say so. */
  license?: string;
  /** The repo needs accepted terms or a token; we surface it rather than failing mid-download. */
  gated?: boolean;
  /** Hearts on Hugging Face, next to the download count. */
  likes?: number;
  /** Last commit to the repo, for the "is this maintained" question. */
  updatedAt?: number;
  createdAt?: number;
  /** The task the publisher declared, e.g. `text-generation`. */
  pipelineTag?: string;
  /** The weights this GGUF was converted from, when the repo says so. */
  baseModel?: string;
  /** Every tag the repo carries, not just the capability chips. */
  hfTags?: string[];
}

/**
 * A catalog model with the things only its own page has room for.
 *
 * The extra call this needs is the model card itself, which is a README on
 * Hugging Face and can run to thousands of words. It is fetched when a model is
 * opened rather than with the list, so browsing stays one request per search
 * instead of one per result.
 */
export interface CatalogModelDetail extends CatalogModel {
  /** The model card, as markdown, with its YAML front matter stripped. */
  readme?: string;
  /** Set when the card could not be read, so the page can say why. */
  readmeError?: string;
  /** Other repos publishing GGUF builds of the same weights. */
  related?: CatalogModel[];
}

export type DownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled';

/** One file being fetched, whether it is an engine build or a model. */
export interface DownloadJob {
  id: string;
  kind: 'model' | 'engine';
  /** What the UI calls it. */
  label: string;
  /** Model id for a model job; build id for an engine job. */
  target: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes?: number;
  /** Bytes per second over the last window, for the ETA. */
  bytesPerSecond?: number;
  startedAt: number;
  finishedAt?: number;
  message?: string;
}

/** A GGUF on disk, with whatever the header told us. */
export interface LocalModel {
  /** `<owner>/<repo>/<file>` for a downloaded model; the file name for an imported one. */
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  quantization?: string;
  parameterSize?: string;
  architecture?: string;
  layers?: number;
  kvHeads?: number;
  headDim?: number;
  maxContext?: number;
  /** Set when the file came from the catalog rather than an import. */
  sourceRepo?: string;
  /** The folder this file was found in, or `primary` for our own models dir. */
  folderId?: string;
  /** The app whose layout that folder belongs to, when we recognised one. */
  folderProvider?: ModelFolderProviderId;
  /** False for a folder we only read: deleting there would break another app. */
  managed?: boolean;
  addedAt: number;
  /** Per-model saved load settings, applied when it is loaded. */
  preset?: EngineLoadPreset;
}

/**
 * Saved load settings for one model.
 *
 * Kept separate from `LoadParams` because this is the persisted form: every field
 * optional, absent meaning "decide from the budget" rather than "use zero".
 */
export interface EngineLoadPreset {
  contextTokens?: number;
  gpuLayers?: number;
  kvCacheDtype?: KvCacheDtype;
  batchSize?: number;
  ubatchSize?: number;
  threads?: number;
  parallelSlots?: number;
  flashAttention?: boolean;
  mmap?: boolean;
  mlock?: boolean;
  ropeFreqBase?: number;
  ropeFreqScale?: number;
  seed?: number;
  ttlSeconds?: number;
  /** The simple slider's position, kept so the two surfaces stay one state. */
  budgetFraction?: number;
}

/* ------------------------------------------------------- model folders */

/**
 * The apps whose model folders we know how to find.
 *
 * A GGUF on this machine is a GGUF whoever downloaded it, so a model already
 * pulled through Ollama or LM Studio should not have to be downloaded a second
 * time to be run here. Each id is a layout we know the default path of and, for
 * Ollama, a naming scheme we know how to read.
 */
export type ModelFolderProviderId =
  | 'nekko'
  | 'ollama'
  | 'lmstudio'
  | 'jan'
  | 'gpt4all'
  | 'llamacpp'
  | 'huggingface'
  | 'koboldcpp'
  | 'textgenwebui'
  | 'localai'
  | 'bionic'
  | 'vllm';

export interface ModelFolderProvider {
  label: string;
  /** One line for the folder list: what put models here. */
  hint: string;
}

export const MODEL_FOLDER_PROVIDERS: Record<ModelFolderProviderId, ModelFolderProvider> = {
  nekko: { label: 'Agent Nekko', hint: 'Models downloaded here.' },
  ollama: { label: 'Ollama', hint: 'Ollama stores models as hashed blobs; names come from its manifests.' },
  lmstudio: { label: 'LM Studio', hint: 'LM Studio keeps GGUF files under publisher/repo.' },
  jan: { label: 'Jan', hint: 'Jan keeps one folder per model.' },
  gpt4all: { label: 'GPT4All', hint: 'GPT4All keeps every GGUF in one folder.' },
  llamacpp: { label: 'llama.cpp', hint: "llama.cpp's own models folder." },
  huggingface: { label: 'Hugging Face cache', hint: 'Anything pulled with huggingface-cli or the Python libraries.' },
  koboldcpp: { label: 'KoboldCpp', hint: 'KoboldCpp model folder.' },
  textgenwebui: { label: 'Text generation web UI', hint: "oobabooga's models folder." },
  localai: { label: 'LocalAI', hint: 'LocalAI model folder.' },
  bionic: { label: 'Bionic', hint: 'Bionic GPT model folder.' },
  vllm: { label: 'vLLM', hint: 'vLLM serves from the Hugging Face cache by default.' },
};

/** Where the library looks for models, beyond the folder we download into. */
export interface ModelFolder {
  /** Stable id, also the prefix of every model id found here. */
  id: string;
  path: string;
  /** Set when this folder matches a layout we know. */
  provider?: ModelFolderProviderId;
  /** Off without being forgotten: kept in the list, skipped on a scan. */
  enabled: boolean;
  /** The user typed this one in rather than us finding it. */
  custom?: boolean;
}

/**
 * A folder as the settings page shows it: what we have configured, plus what the
 * last scan actually found there.
 *
 * `primary` is the one folder downloads land in. It is always present, always
 * enabled, and cannot be removed, which is why it is a flag rather than another
 * row the user could delete out from under a download.
 */
export interface ModelFolderStatus extends ModelFolder {
  primary?: boolean;
  exists: boolean;
  modelCount: number;
  sizeBytes: number;
  /** Why nothing was read, when something went wrong rather than nothing being there. */
  error?: string;
}

/** A known folder we found on this machine that is not in the list yet. */
export interface ModelFolderSuggestion {
  provider: ModelFolderProviderId;
  path: string;
  modelCount: number;
  sizeBytes: number;
}

export interface ModelFolderReport {
  folders: ModelFolderStatus[];
  /** Known layouts present on disk that nobody has added yet. */
  suggestions: ModelFolderSuggestion[];
}
