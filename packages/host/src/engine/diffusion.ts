import { readdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import type { EngineBuild, EnginePlatform, GpuStats, LocalModel } from '@agent-nekko/shared';
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

export async function diffusionArgs(model: LocalModel, port: number, ownedCompanions?: string): Promise<string[]> {
  const preset = model.preset?.diffusion ?? {};
  const dirs = [dirname(model.path), ownedCompanions].filter((d): d is string => !!d);
  const found: Record<string, string> = {};
  for (const dir of dirs) {
    const files = await readdir(dir).catch(() => []);
    for (const key of ['clip_l', 'clip_g', 't5xxl', 'vae', 'llm'] as const) {
      const file = files.find(f => new RegExp(`^${key.replace('_', '[_-]')}[_.-]`, 'i').test(f) && /\.(gguf|safetensors|sft)$/i.test(f));
      if (file && !found[key]) found[key] = join(dir, file);
    }
  }
  const paths = { ...found, ...preset };
  const args = [preset.standalone === false ? '--model' : '--diffusion-model', model.path, '--listen-ip', '127.0.0.1', '--listen-port', String(port)];
  if (/sd3|stable.diffusion.3/i.test(`${model.architecture} ${model.name}`)) {
    for (const key of ['clip_l', 'clip_g', 't5xxl']) {
      if (!paths[key as keyof typeof paths]) throw new Error(`Missing ${key} text encoder for ${model.name}. Set its companion path in image settings.`);
    }
  }
  for (const key of ['clip_l', 'clip_g', 't5xxl', 'vae', 'llm'] as const) {
    const path = paths[key];
    if (!path) continue;
    if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`The ${key} companion file does not exist: ${path}`);
    args.push(`--${key}`, path);
  }
  if (preset.offloadToCpu) args.push('--offload-to-cpu');
  if (preset.clipOnCpu) args.push('--clip-on-cpu');
  return args;
}
