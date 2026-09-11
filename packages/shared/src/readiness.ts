/**
 * Machine-readiness types for the offline PC-control stack (AN9).
 *
 * The shape mirrors the capacity planner's contracts: facts in, a structured
 * verdict out, no I/O anywhere in the evaluator. The advisor's job is different
 * though. `planFit` asks "does this one model fit right now"; this asks "which
 * set of concurrently resident components (runtime + intent LLM + STT + TTS)
 * should this machine get, and how sure are we".
 *
 * That second question adds three things a model list does not need: platform
 * gates (the catalog carries binary artifacts, so OS/arch/CPU-feature/backend
 * compatibility is per-entry), a combined memory + disk budget across the whole
 * stack, and a four-level verdict where `unverified` means "a probe we needed
 * did not answer", never a guess.
 */

import type { CapacityDevice } from './capacity.js';

/** One job in the concurrently-resident offline stack. */
export type StackRole = 'runtime' | 'intent' | 'stt' | 'tts';

export const STACK_ROLES: StackRole[] = ['runtime', 'intent', 'stt', 'tts'];

export interface MachineOs {
  /** Node platform string: 'darwin' | 'win32' | 'linux' | ... */
  platform: string;
  /** Kernel/OS release (os.release()). */
  release: string;
  /** os.arch(): 'x64' | 'arm64' | ... */
  arch: string;
}

export interface MachineFacts {
  os: MachineOs;
  /**
   * Instruction features we could prove (e.g. 'avx2'). `null` means the probe
   * did not run on this platform, which is a statement about our evidence, not
   * about the CPU: entries that require a feature are capped at `unverified`
   * rather than guessed at.
   */
  cpuFeatures: string[] | null;
  /** Compute backends the machine can run: e.g. 'cuda', 'metal', 'vulkan', 'cpu'. */
  backends: string[];
  /** GPU memory pools. Never summed together. */
  devices: CapacityDevice[];
  /** GPU and CPU share one pool (Apple Silicon). */
  unified: boolean;
  systemRamTotalBytes: number;
  systemRamFreeBytes: number;
  /** Free space on the install volume; `null` when it could not be probed. */
  diskFreeBytes: number | null;
}

/** Hard gates for a catalog entry. An absent field means "no constraint". */
export interface CatalogRequires {
  os?: string[];
  arch?: string[];
  /** Every listed feature must be *proven* present. */
  cpuFeatures?: string[];
  /** At least one listed backend must be present. */
  backends?: string[];
  /** Against total installed RAM, not the fluctuating free figure. */
  minRamBytes?: number;
  /** A single device must have at least this much total VRAM (no pooling). */
  minVramBytes?: number;
  minDiskBytes?: number;
}

/** The comfort bar above bare compatibility, driving `recommended`. */
export interface CatalogRecommended {
  backends?: string[];
  minRamBytes?: number;
  minVramBytes?: number;
}

/** Where the bytes come from, consumed by the acquisition slice (AN9c). */
export interface CatalogArtifact {
  /** Canonical repository, e.g. 'bartowski/Qwen2.5-7B-Instruct-GGUF'. */
  repo: string;
  /** Repo-relative file path. */
  file: string;
  /** Pinned content hash. Absent means not yet pinned: reported, never invented. */
  sha256?: string;
  license: string;
}

export interface CatalogEntry {
  id: string;
  role: StackRole;
  name: string;
  /**
   * Languages the component covers, BCP-47-ish codes ('en', 'ja', ...).
   * `'any'` for language-agnostic components (intent LLMs, runtimes).
   */
  languages: string[] | 'any';
  quantization?: string;
  artifact: CatalogArtifact;
  /** Disk footprint once installed. */
  installBytes: number;
  /** Resident memory while running at the pinned configuration. */
  memoryBytes: number;
  /** Prefers GPU residency when one fits it (intent LLMs). Falls back to RAM. */
  prefersGpu?: boolean;
  requires?: CatalogRequires;
  recommended?: CatalogRecommended;
}

export interface ReadinessCatalog {
  /** Whole-catalog data version; bump whenever any entry changes. */
  version: string;
  entries: CatalogEntry[];
}

export type ReadinessVerdict = 'recommended' | 'compatible' | 'insufficient' | 'unverified';

export type ReadinessReasonCode =
  | 'unsupported-os'
  | 'unsupported-arch'
  | 'missing-cpu-feature'
  | 'missing-backend'
  | 'low-memory'
  | 'low-vram'
  | 'low-disk'
  | 'cpu-feature-unprobed'
  | 'disk-unprobed'
  | 'artifact-unpinned'
  | 'devices-not-pooled'
  | 'unified-memory'
  | 'combined-exceeds-memory'
  | 'combined-exceeds-disk'
  | 'unsupported-language'
  | 'no-candidate'
  | 'below-recommended'
  | 'cpu-only';

export interface ReadinessReason {
  code: ReadinessReasonCode;
  /** Bytes the reason is about, when it is about bytes. */
  bytes?: number;
  /** Detail for codes that need one (a feature name, a language code). */
  detail?: string;
}

export interface RoleAssessment {
  role: StackRole;
  verdict: ReadinessVerdict;
  /** The entry selected for the stack, when one is usable. */
  pick: CatalogEntry | null;
  /** Other eligible entries, for UI alternates. */
  alternates: CatalogEntry[];
  reasons: ReadinessReason[];
}

export interface ReadinessReport {
  /** The whole concurrently-loaded stack: the worst role, plus combined checks. */
  verdict: ReadinessVerdict;
  /** Catalog data version this report was computed against. */
  catalogVersion: string;
  roles: RoleAssessment[];
  combined: {
    /** Sum of picked components' resident memory. */
    memoryBytes: number;
    /** The pool it is measured against (VRAM pool + RAM, or unified once). */
    budgetBytes: number;
    /** Sum of picked components' install footprints. */
    installBytes: number;
    diskFreeBytes: number | null;
  };
  reasons: ReadinessReason[];
  /** Facts that could not be probed, so the UI can name each assumption. */
  unknowns: string[];
}
