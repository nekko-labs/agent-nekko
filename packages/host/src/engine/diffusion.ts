import { stat } from 'fs/promises';
import type { EngineBuild, EnginePlatform, GpuStats, ImageCompanionRole, LocalModel } from '@agent-nekko/shared';
import { companionsBeside, imageCompanionSetFor, imageCompanionStatus } from './image-companions.js';
import { buildsFor } from './builds.js';

export function diffusionBuilds(platform: EnginePlatform, arch: string, gpu: GpuStats | null): EngineBuild[] {
  return buildsFor(platform, arch, gpu).filter(b =>
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'linux' && arch === 'x64' && b.backend !== 'cuda') ||
    (platform === 'darwin' && arch === 'arm64')
  ).map(b => ({ ...b, id: `sd-${b.id}`, assetPattern: b.backend, companionPattern: b.backend === 'cuda' ? 'cudart-sd' : undefined }));
}

export function matchDiffusionAsset(build: EngineBuild, names: string[]): string | undefined {
  const suffix = build.platform === 'darwin' ? /bin-Darwin-.*-arm64\.zip$/ : build.platform === 'linux'
    ? new RegExp(`bin-Linux-.*-x86_64${build.backend === 'cpu' ? '' : `-${build.backend === 'hip' ? 'rocm-.*' : build.backend}`}\\.zip$`)
    : new RegExp(`bin-win-${build.backend === 'hip' ? 'rocm-.*' : build.backend === 'cuda' ? 'cuda12' : build.backend}-x64\\.zip$`);
  return names.find(n => n.startsWith('sd-') && suffix.test(n));
}

export function matchDiffusionCompanion(build: EngineBuild, _asset: string, names: string[]): string | undefined {
  return build.backend === 'cuda' ? names.find(n => n === 'cudart-sd-bin-win-cu12-x64.zip') : undefined;
}

const ROLES = ['clip_l', 'clip_g', 't5xxl', 'vae', 'llm', 'taesd'] as const;

/**
 * sd-server's arguments for one image model.
 *
 * Companion paths come from, highest first: the model's image settings, files
 * beside the weights (or in its own companions dir) named the way sd.cpp users
 * lay them out by hand, and the shared set the image panel downloads. A model
 * whose family needs companions it does not have fails here, naming them,
 * instead of starting a server that dies on its first request.
 */
export async function diffusionArgs(model: LocalModel, port: number | string, ownedCompanions?: string, sharedCompanions?: string): Promise<string[]> {
  const preset = model.preset?.diffusion ?? {};
  const set: Partial<Record<ImageCompanionRole, string>> = {};
  const beside = await companionsBeside(model, ownedCompanions ? [ownedCompanions] : []);
  const status = sharedCompanions ? await imageCompanionStatus(model, sharedCompanions) : null;
  for (const f of status?.files ?? []) if (f.path) set[f.usingFallback ? 'taesd' : f.role] = f.path;
  const chosen = Object.fromEntries(ROLES.filter((r) => typeof preset[r] === 'string' && preset[r]).map((r) => [r, preset[r] as string]));
  const paths: Partial<Record<ImageCompanionRole, string>> = { ...set, ...beside, ...chosen };

  const args = [preset.standalone === false ? '--model' : '--diffusion-model', model.path, '--listen-ip', '127.0.0.1', '--listen-port', String(port)];
  const family = imageCompanionSetFor(model);
  if (family) {
    // A full checkpoint carries its own VAE; its text encoders are still separate files.
    const missing = family.files
      .map((f) => f.role)
      .filter((r) => !(preset.standalone === false && r === 'vae'))
      .filter((r) => !paths[r] && !(r === 'vae' && paths.taesd));
    if (missing.length) {
      throw new Error(`${model.name} (${family.label}) is missing ${missing.join(', ')}. Download them from its image panel, or set their paths in image settings.`);
    }
  }
  for (const key of ROLES) {
    const path = paths[key];
    if (!path) continue;
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`The ${key} companion file does not exist: ${path}`);
    args.push(`--${key}`, path);
  }
  if (preset.offloadToCpu) args.push('--offload-to-cpu');
  if (preset.clipOnCpu) args.push('--clip-on-cpu');
  return args;
}
