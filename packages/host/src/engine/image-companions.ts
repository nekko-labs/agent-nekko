import { readdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { ImageCompanionRole, ImageCompanionStatus, LocalModel } from '@nekko-agent/shared';

/**
 * The text encoders and VAEs an image model needs beside its diffusion weights.
 *
 * A GGUF diffusion model (city96's SD3.5, unsloth's FLUX.2 klein) holds only
 * the transformer: stable-diffusion.cpp also needs the model's text encoders
 * and the VAE that turns latents into pixels, and without them it refuses to
 * start. These sets name, per model family, which files those are and where on
 * Hugging Face an ungated copy lives, so one press fetches them.
 *
 * The files land in one shared directory (`<models>/.companions/image`) under
 * names that never collide across sets, because two models of a family share
 * them: the FLUX.2 VAE serves klein 4B and 9B, and SD3.5 Large and Medium use
 * the same three text encoders.
 */
export interface ImageCompanionFile {
  role: ImageCompanionRole;
  repo: string;
  file: string;
  /** Name in the shared directory. */
  saveAs: string;
  bytes: number;
  /** The repo needs a Hugging Face token with its license accepted. */
  gated?: boolean;
  /** An ungated stand-in fetched instead when a gated file cannot be. */
  fallback?: Omit<ImageCompanionFile, 'fallback' | 'gated'>;
}

export interface ImageCompanionSet {
  id: string;
  label: string;
  files: ImageCompanionFile[];
  /** Sampling the family is tuned for; distilled models want few steps and no CFG. */
  defaults: { steps: number; cfgScale: number };
}

const FLUX2_VAE: ImageCompanionFile = { role: 'vae', repo: 'Comfy-Org/flux2-dev', file: 'split_files/vae/flux2-vae.safetensors', saveAs: 'vae-flux2.safetensors', bytes: 336_213_556 };
const SD3_ENCODERS = 'Comfy-Org/stable-diffusion-3.5-fp8';
const CLIP_L: ImageCompanionFile = { role: 'clip_l', repo: SD3_ENCODERS, file: 'text_encoders/clip_l.safetensors', saveAs: 'clip_l.safetensors', bytes: 246_144_152 };
const T5XXL: ImageCompanionFile = { role: 't5xxl', repo: SD3_ENCODERS, file: 'text_encoders/t5xxl_fp8_e4m3fn.safetensors', saveAs: 't5xxl_fp8_e4m3fn.safetensors', bytes: 4_893_934_904 };

export const IMAGE_COMPANION_SETS: ImageCompanionSet[] = [
  {
    id: 'flux2-klein-9b',
    label: 'FLUX.2 klein 9B',
    defaults: { steps: 4, cfgScale: 1 },
    files: [FLUX2_VAE, { role: 'llm', repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', saveAs: 'llm-qwen3-8b-q4_k_m.gguf', bytes: 5_027_784_512 }],
  },
  {
    id: 'flux2-klein-4b',
    label: 'FLUX.2 klein 4B',
    defaults: { steps: 4, cfgScale: 1 },
    files: [FLUX2_VAE, { role: 'llm', repo: 'unsloth/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf', saveAs: 'llm-qwen3-4b-q4_k_m.gguf', bytes: 2_497_281_312 }],
  },
  {
    id: 'sd3',
    label: 'Stable Diffusion 3.5',
    defaults: { steps: 28, cfgScale: 4.5 },
    files: [
      CLIP_L,
      { role: 'clip_g', repo: SD3_ENCODERS, file: 'text_encoders/clip_g.safetensors', saveAs: 'clip_g.safetensors', bytes: 1_389_382_176 },
      T5XXL,
      {
        role: 'vae', repo: 'stabilityai/stable-diffusion-3.5-large', file: 'vae/diffusion_pytorch_model.safetensors', saveAs: 'vae-sd3.safetensors', bytes: 167_666_902, gated: true,
        fallback: { role: 'taesd', repo: 'madebyollin/taesd3', file: 'diffusion_pytorch_model.safetensors', saveAs: 'taesd-sd3.safetensors', bytes: 9_848_636 },
      },
    ],
  },
  {
    id: 'flux1',
    label: 'FLUX.1',
    defaults: { steps: 20, cfgScale: 1 },
    files: [
      CLIP_L,
      T5XXL,
      {
        role: 'vae', repo: 'black-forest-labs/FLUX.1-schnell', file: 'ae.safetensors', saveAs: 'vae-flux1.safetensors', bytes: 335_304_388, gated: true,
        fallback: { role: 'taesd', repo: 'madebyollin/taef1', file: 'diffusion_pytorch_model.safetensors', saveAs: 'taesd-flux1.safetensors', bytes: 9_848_636 },
      },
    ],
  },
];

/** Which set a model belongs to, from its GGUF architecture, name and path. */
export function imageCompanionSetFor(model: Pick<LocalModel, 'architecture' | 'name' | 'path'>): ImageCompanionSet | undefined {
  const text = `${model.architecture ?? ''} ${model.name} ${model.path}`.slice(0, 1024).toLowerCase();
  const byId = (id: string) => IMAGE_COMPANION_SETS.find((s) => s.id === id);
  if (/flux[._ -]?2/.test(text) && text.includes('klein')) return byId(/\b4b\b|[-_]4b[-_.]/.test(text) ? 'flux2-klein-4b' : 'flux2-klein-9b');
  // FLUX.2 dev pairs with a 24B Mistral encoder; no set until a small quant exists.
  if (/flux[._ -]?2/.test(text)) return undefined;
  if (model.architecture === 'sd3' || /sd3|stable.diffusion.3/.test(text)) return byId('sd3');
  if (model.architecture === 'flux' || /flux[._ -]?1/.test(text)) {
    const flux1 = byId('flux1') as ImageCompanionSet;
    // schnell is the 4-step distillation; dev wants the full schedule.
    return text.includes('schnell') ? { ...flux1, defaults: { steps: 4, cfgScale: 1 } } : flux1;
  }
  return undefined;
}

export function imageCompanionsDir(modelsDir: string): string {
  return join(modelsDir, '.companions', 'image');
}

const present = (path: string) => stat(path).then((s) => s.isFile() && s.size > 0).catch(() => false);

/**
 * What a model's set has on disk. A role counts as covered when the user set a
 * path for it, a matching file sits beside the weights, or the shared directory
 * holds the set's file (or, for a gated VAE, its fallback).
 */
export async function imageCompanionStatus(model: LocalModel, dir: string, beside: Partial<Record<ImageCompanionRole, string>> = {}, hasToken = false): Promise<ImageCompanionStatus | null> {
  const set = imageCompanionSetFor(model);
  if (!set) return null;
  const preset = model.preset?.diffusion ?? {};
  const files = await Promise.all(set.files.map(async (f) => {
    const own = preset[f.role as keyof typeof preset] as string | undefined ?? beside[f.role];
    const shared = join(dir, f.saveAs);
    const fallback = f.fallback ? join(dir, f.fallback.saveAs) : undefined;
    const path = own && (await present(own)) ? own
      : (await present(shared)) ? shared
      : fallback && (await present(fallback)) ? fallback
      : undefined;
    // Without a token a gated file cannot be fetched: report what will be.
    const fetches = f.gated && !hasToken && f.fallback ? f.fallback : f;
    return { role: f.role, source: `${fetches.repo}/${fetches.file}`, bytes: fetches.bytes, gated: fetches === f && !!f.gated, path, usingFallback: path ? path === fallback : fetches !== f };
  }));
  const missingBytes = files.filter((f) => !f.path).reduce((n, f) => n + f.bytes, 0);
  return { setId: set.id, label: set.label, files, ready: files.every((f) => f.path), missingBytes, defaults: set.defaults };
}

/** Beside-the-weights files, found the way sd.cpp users lay them out by hand. */
export async function companionsBeside(model: LocalModel, dirs: string[]): Promise<Partial<Record<ImageCompanionRole, string>>> {
  const found: Partial<Record<ImageCompanionRole, string>> = {};
  for (const d of [dirname(model.path), ...dirs]) {
    const names = await readdir(d).catch(() => [] as string[]);
    for (const role of ['clip_l', 'clip_g', 't5xxl', 'vae', 'llm', 'taesd'] as const) {
      const file = names.find((f) => new RegExp(`^${role.replace('_', '[_-]')}[_.-]`, 'i').test(f) && /\.(gguf|safetensors|sft)$/i.test(f));
      if (file && !found[role]) found[role] = join(d, file);
    }
  }
  return found;
}
