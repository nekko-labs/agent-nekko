import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { modelModality, type LocalModel } from '@nekko-agent/shared';
import { diffusionBuilds, matchDiffusionAsset, matchDiffusionCompanion, diffusionArgs } from './diffusion.js';
import { createEngineInstaller } from './install.js';
import { createDownloads } from './download.js';
import { imageCompanionSetFor, imageCompanionStatus } from './image-companions.js';
import { RUNTIME_RELEASES } from './runtime-releases.js';

// Releases are fetched by the pinned tag, which the runtime updater bumps; the
// fixtures follow it so an update PR is judged on its own merits.
const TAG = RUNTIME_RELEASES.diffusion.tag;
const SHA = TAG.split('-').pop();
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('diffusion runtime', () => {
  it('recognizes diffusion downloads before their GGUF header exists', () => {
    expect(modelModality({ name: 'city96/stable-diffusion-3.5-large-gguf sd3.5_large-Q8_0.gguf' })).toBe('image');
    expect(modelModality({ name: 'FLUX.1-dev-Q4_0.gguf' })).toBe('image');
    expect(modelModality({ name: 'Qwen3-4B.gguf' })).toBe('chat');
  });
  it('matches platform, arch, backend and paired CUDA libraries', () => {
    const names = ['sd-master-abc-bin-win-cuda12-x64.zip', 'cudart-sd-bin-win-cu12-x64.zip', 'sd-master-abc-bin-win-cpu-x64.zip', 'sd-master-abc-bin-Linux-Ubuntu-24.04-x86_64.zip', 'sd-master-abc-bin-Darwin-macOS-26.6.2-arm64.zip'];
    const win = diffusionBuilds('win32', 'x64', null).find(b => b.backend === 'cuda')!;
    expect(matchDiffusionAsset(win, names)).toBe(names[0]);
    expect(matchDiffusionCompanion(win, names[0], names)).toBe(names[1]);
    expect(diffusionBuilds('win32', 'arm64', null)).toEqual([]);
    expect(matchDiffusionAsset(diffusionBuilds('darwin', 'arm64', null)[0], names)).toBe(names[4]);
    expect(matchDiffusionAsset(diffusionBuilds('linux', 'x64', null)[0], names)).toBe(names[3]);
  });
  it('previews the pinned release and counts all required archive bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-sd-preview-')); dirs.push(dir);
    const installer = createEngineInstaller({ runtime: 'diffusion', engineDir: () => dir, downloads: createDownloads({}), getGpuStats: async () => null, platform:'win32', arch:'x64', run: async () => null,
      fetch: (async () => new Response(JSON.stringify({ tag_name:TAG, assets: [
        { name: `sd-master-${SHA}-bin-win-cuda12-x64.zip`, browser_download_url:'https://github.com/example/main.zip', size:300 },
        { name: 'cudart-sd-bin-win-cu12-x64.zip', browser_download_url:'https://github.com/example/libs.zip', size:600 },
      ] }))) as typeof fetch });
    expect((await installer.preview('sd-win-x64-cuda'))?.sizeBytes).toBe(900);
  });
  it('rejects a corrupt archive before extraction or installation', async () => {
    const dir=await mkdtemp(join(tmpdir(),'nekko-sd-checksum-'));dirs.push(dir);
    const downloads=createDownloads({fetch:(async()=>new Response('corrupt archive')) as typeof fetch});
    const run=vi.fn(async()=>null);
    const installer=createEngineInstaller({runtime:'diffusion',engineDir:()=>dir,downloads,getGpuStats:async()=>null,platform:'win32',arch:'x64',run,fetch:(async()=>new Response(JSON.stringify({tag_name:TAG,assets:[{name:`sd-master-${SHA}-bin-win-cpu-x64.zip`,size:15,browser_download_url:'https://github.com/example/runtime.zip',digest:`sha256:${'0'.repeat(64)}`}]}))) as typeof fetch});
    expect((await installer.install('sd-win-x64-cpu')).ok).toBe(true);
    await vi.waitFor(()=>expect(downloads.list()[0].state).toBe('failed'));
    expect(downloads.list()[0].message).toMatch(/checksum/);expect(run).not.toHaveBeenCalled();
  });
  it('refuses to uninstall external binaries and never removes models', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-sd-external-')); dirs.push(dir);
    const bin = join(dir,'external.exe'); await writeFile(bin,'fixture'); const owned=join(dir,'engine'); await mkdir(owned);
    const installer=createEngineInstaller({runtime:'diffusion',engineDir:()=>owned,downloads:createDownloads(),getGpuStats:async()=>null,externalPath:()=>bin,run:async()=>null});
    expect((await installer.detect()).source).toBe('external'); expect((await installer.uninstall()).ok).toBe(false); expect((await stat(bin)).isFile()).toBe(true);
    await writeFile(join(owned,'engine.json'),JSON.stringify({buildId:'../external',binPath:bin})); expect((await installer.uninstall()).ok).toBe(false); expect((await stat(bin)).isFile()).toBe(true);
  });
  it('names missing SD3.5 encoders and uses diffusion flags instead of llama flags', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-sd-args-')); dirs.push(dir);
    const model: LocalModel = { id:'sd3', name:'sd3.5_large', architecture:'sd3', modality:'image', path:join(dir,'sd3.gguf'), sizeBytes:1, addedAt:1 };
    await expect(diffusionArgs(model,1234)).rejects.toThrow('clip_l');
    for (const key of ['clip_l','clip_g','t5xxl']) await writeFile(join(dir,`${key}.safetensors`),'fixture');
    await expect(diffusionArgs(model,1234)).rejects.toThrow('vae');
    await writeFile(join(dir,'vae-sd3.safetensors'),'fixture');
    const args = await diffusionArgs(model,1234);
    expect(args).toContain('--diffusion-model');
    expect(args).toContain('--clip_l');
    expect(args).toContain('--listen-port');
    expect(args).not.toContain('--ctx-size');
  });
  it('matches companion sets by family and size', () => {
    const at = (name: string, architecture = 'flux') => imageCompanionSetFor({ name, architecture, path: join('lm', name) })?.id;
    expect(at('flux-2-klein-9b-Q8_0')).toBe('flux2-klein-9b');
    expect(at('FLUX.2-klein-4B-Q4_K_M')).toBe('flux2-klein-4b');
    expect(at('flux2-dev-Q4_0')).toBeUndefined();
    expect(at('flux1-dev-Q4_0')).toBe('flux1');
    expect(at('sd3.5_large-Q8_0', 'sd3')).toBe('sd3');
    expect(at('some-sdxl-finetune', 'sdxl')).toBeUndefined();
  });
  it('uses the shared companion dir, requires FLUX.2 vae and llm, and lets a TAESD stand in for a gated VAE', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-sd-shared-')); dirs.push(dir);
    const shared = join(dir, 'shared'); await mkdir(shared);
    const klein: LocalModel = { id:'k', name:'flux-2-klein-9b-Q8_0', architecture:'flux', modality:'image', path:join(dir,'flux-2-klein-9b-Q8_0.gguf'), sizeBytes:1, addedAt:1 };
    await expect(diffusionArgs(klein, 1, undefined, shared)).rejects.toThrow(/vae, llm/);
    await writeFile(join(shared,'vae-flux2.safetensors'),'x');
    // A 4B encoder in the shared dir is not the 9B's.
    await writeFile(join(shared,'llm-qwen3-4b-q4_k_m.gguf'),'x');
    await expect(diffusionArgs(klein, 1, undefined, shared)).rejects.toThrow(/llm/);
    await writeFile(join(shared,'llm-qwen3-8b-q4_k_m.gguf'),'x');
    const args = await diffusionArgs(klein, 1, undefined, shared);
    expect(args[args.indexOf('--llm') + 1]).toBe(join(shared,'llm-qwen3-8b-q4_k_m.gguf'));
    expect(args[args.indexOf('--vae') + 1]).toBe(join(shared,'vae-flux2.safetensors'));
    // The user's own path wins over the shared file.
    await writeFile(join(dir,'mine.gguf'),'x');
    const own = await diffusionArgs({ ...klein, preset: { diffusion: { llm: join(dir,'mine.gguf') } } }, 1, undefined, shared);
    expect(own[own.indexOf('--llm') + 1]).toBe(join(dir,'mine.gguf'));

    const sd3: LocalModel = { id:'s', name:'sd3.5_large-Q8_0', architecture:'sd3', modality:'image', path:join(dir,'sd3.5_large-Q8_0.gguf'), sizeBytes:1, addedAt:1 };
    for (const f of ['clip_l.safetensors','clip_g.safetensors','t5xxl_fp8_e4m3fn.safetensors','taesd-sd3.safetensors']) await writeFile(join(shared,f),'x');
    const status = await imageCompanionStatus(sd3, shared);
    expect(status?.ready).toBe(true);
    expect(status?.files.find(f => f.role === 'vae')?.usingFallback).toBe(true);
    const sdArgs = await diffusionArgs(sd3, 1, undefined, shared);
    expect(sdArgs).toContain('--taesd');
    expect(sdArgs).not.toContain('--vae');
  });
});
