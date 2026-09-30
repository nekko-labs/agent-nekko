import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMlxRuntime, mlxArgs, mlxSupported, readMlxModel } from './mlx.js';
import type { Downloads } from './download.js';

function modelDir(name: string, config: object, weights = ['model.safetensors']): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'nekko-models-')), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  for (const w of weights) writeFileSync(join(dir, w), Buffer.alloc(1024));
  return dir;
}

describe('MLX models on disk', () => {
  it('reads an MLX-quantized folder', async () => {
    const dir = modelDir('Qwen3-8B-4bit', {
      model_type: 'qwen3',
      quantization: { group_size: 64, bits: 4 },
      max_position_embeddings: 40960,
    }, ['model-00001-of-00002.safetensors', 'model-00002-of-00002.safetensors']);
    const info = await readMlxModel(dir);
    expect(info).toMatchObject({ architecture: 'qwen3', quantization: '4-bit', maxContext: 40960, vision: false, sizeBytes: 2048 });
  });

  it('accepts an unquantized folder only when its path says MLX', async () => {
    expect(await readMlxModel(modelDir('mlx-community-gemma', { model_type: 'gemma3' }))).not.toBeNull();
    // A plain transformers checkpoint has the same files and is not MLX.
    expect(await readMlxModel(modelDir('bert-base', { model_type: 'bert' }))).toBeNull();
  });

  it('marks vision models', async () => {
    const info = await readMlxModel(modelDir('mlx-vl', { model_type: 'qwen2_5_vl', vision_config: {} }));
    expect(info?.vision).toBe(true);
  });

  it('is not a model without weights', async () => {
    expect(await readMlxModel(modelDir('mlx-empty', { model_type: 'llama' }, []))).toBeNull();
  });
});

describe('MLX runtime', () => {
  const fakeDownloads = () => {
    const started: any[] = [];
    return {
      started,
      downloads: {
        start: async (req: any) => {
          started.push(req);
          return { id: req.id };
        },
      } as unknown as Downloads,
    };
  };

  it('is offered on Apple Silicon only', async () => {
    expect(mlxSupported('darwin', 'arm64')).toBe(true);
    expect(mlxSupported('darwin', 'x64')).toBe(false);
    expect(mlxSupported('win32', 'x64')).toBe(false);
    const { downloads } = fakeDownloads();
    const pc = createMlxRuntime({ dir: () => tmpdir(), downloads, platform: 'win32', arch: 'x64', which: async () => null });
    expect((await pc.detect()).available).toEqual([]);
    expect((await pc.install()).ok).toBe(false);
    expect(await pc.binPath()).toBeUndefined();
  });

  it('installs uv, then mlx-lm into the engine folder, as one download job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-mlx-rt-'));
    const { downloads, started } = fakeDownloads();
    const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
    const rt = createMlxRuntime({
      dir: () => dir,
      downloads,
      platform: 'darwin',
      arch: 'arm64',
      which: async () => null,
      fetch: (async () =>
        new Response(JSON.stringify({ assets: [{ name: 'uv-aarch64-apple-darwin.tar.gz', browser_download_url: 'https://example/uv.tgz' }] }))) as typeof fetch,
      exec: async (cmd, args, env) => {
        calls.push({ cmd, args, env });
        if (args[0] === 'tool') {
          mkdirSync(join(dir, 'bin'), { recursive: true });
          writeFileSync(join(dir, 'bin', 'mlx_lm.server'), '#!/bin/sh\n');
        }
        return '';
      },
    });
    const res = await rt.install();
    expect(res.ok).toBe(true);
    expect(started).toHaveLength(1);
    // The job's after-hook unpacks uv and installs mlx-lm.
    const problem = await started[0].after(join(dir, 'uv', 'uv-aarch64-apple-darwin.tar.gz'), new AbortController().signal);
    expect(problem).toBeNull();
    expect(calls[0].cmd).toBe('tar');
    expect(calls[1].args.slice(0, 2)).toEqual(['tool', 'install']);
    expect(calls[1].env.UV_TOOL_BIN_DIR).toBe(join(dir, 'bin'));
    expect((await rt.detect()).source).toBe('managed');
    expect(await rt.binPath()).toBe(join(dir, 'bin', 'mlx_lm.server'));
  });

  it('uses an mlx_lm.server already on PATH, and will not remove it', async () => {
    const { downloads } = fakeDownloads();
    const rt = createMlxRuntime({ dir: () => tmpdir(), downloads, platform: 'darwin', arch: 'arm64', which: async () => '/opt/homebrew/bin/mlx_lm.server' });
    expect((await rt.detect()).source).toBe('external');
    expect((await rt.uninstall()).ok).toBe(false);
  });

  it('builds server arguments, with a draft model when one is attached', () => {
    const m = { id: 'q', name: 'q', path: '/models/q', sizeBytes: 1, addedAt: 0 };
    expect(mlxArgs(m, '{port}', {})).toEqual(['--model', '/models/q', '--host', '127.0.0.1', '--port', '{port}']);
    expect(mlxArgs(m, 9000, {}, '/models/d')).toContain('--draft-model');
    expect(mlxArgs(m, 9000, { speculative: false }, '/models/d')).not.toContain('--draft-model');
  });
});
