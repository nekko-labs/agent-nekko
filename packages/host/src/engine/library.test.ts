import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLibrary } from './library.js';
import { buildGguf, str, u32 } from './gguf-fixture.js';

/**
 * The library treats the files as the truth and the index as a cache, so these
 * tests are mostly about reconciliation: a file dropped in by hand appears, a
 * file deleted outside the app disappears, and the pieces of a split model do
 * not masquerade as models of their own.
 */

let dir: string;
let library: ReturnType<typeof createLibrary>;

const gguf = (name: string, over: Array<[string, ReturnType<typeof u32>]> = []) =>
  writeFile(
    join(dir, name),
    buildGguf([
      ['general.architecture', str('llama')],
      ['general.name', str(name.replace(/\.gguf$/, ''))],
      ['general.file_type', u32(15)],
      ['llama.block_count', u32(32)],
      ['llama.attention.head_count', u32(32)],
      ['llama.attention.head_count_kv', u32(8)],
      ['llama.embedding_length', u32(4096)],
      ['llama.context_length', u32(32768)],
      ...over,
    ]),
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nekko-lib-'));
  library = createLibrary({ modelsDir: () => dir });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('model library', () => {
  it('reads geometry from the file itself, so the planner gets real numbers', async () => {
    await gguf('qwen3-8b.gguf');
    const [model] = await library.list();

    expect(model.layers).toBe(32);
    expect(model.kvHeads).toBe(8);
    expect(model.headDim).toBe(128);
    expect(model.maxContext).toBe(32768);
    expect(model.quantization).toBe('Q4_K_M');
  });

  it('picks up a file dropped into the folder by hand', async () => {
    expect(await library.list()).toHaveLength(0);
    await gguf('dropped-in.gguf');
    expect(await library.list()).toHaveLength(1);
  });

  it('drops a row whose file was deleted outside the app', async () => {
    await gguf('gone.gguf');
    expect(await library.list()).toHaveLength(1);

    await rm(join(dir, 'gone.gguf'));
    expect(await library.list()).toHaveLength(0);
  });

  it('finds models in subfolders, which is how downloads are filed', async () => {
    await mkdir(join(dir, 'bartowski_Qwen2.5-7B-Instruct-GGUF'), { recursive: true });
    await writeFile(
      join(dir, 'bartowski_Qwen2.5-7B-Instruct-GGUF', 'qwen.gguf'),
      buildGguf([
        ['general.architecture', str('qwen2')],
        ['qwen2.block_count', u32(28)],
      ]),
    );

    const [model] = await library.list();
    // The id is the path below the models dir, so it is stable and URL-safe.
    expect(model.id).toBe('bartowski_Qwen2.5-7B-Instruct-GGUF/qwen');
  });

  it('treats a split model as one entry, not as one per shard', async () => {
    await gguf('big-00001-of-00003.gguf');
    await gguf('big-00002-of-00003.gguf');
    await gguf('big-00003-of-00003.gguf');

    const models = await library.list();
    expect(models).toHaveLength(1);
    expect(models[0].id).toContain('00001-of-00003');
  });

  it('does not list a vision projector as a model', async () => {
    await gguf('gemma3-12b.gguf');
    await gguf('mmproj-gemma3-12b.gguf');
    expect((await library.list()).map((m) => m.name)).toEqual(['gemma3-12b']);
  });

  it('refuses to import something that is not a GGUF', async () => {
    const path = join(dir, 'notes.txt');
    await writeFile(path, 'hello');
    const res = await library.importFile(path);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/GGUF/);
  });

  it('refuses to import a .gguf whose contents are not one', async () => {
    const path = join(dir, 'lying.gguf');
    await writeFile(path, 'definitely not a gguf');
    const res = await library.importFile(path);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/readable GGUF/);
  });

  it('deletes a model with its shards and projector', async () => {
    await gguf('big-00001-of-00002.gguf');
    await gguf('big-00002-of-00002.gguf');
    await gguf('mmproj-big.gguf');

    const [model] = await library.list();
    expect((await library.remove(model.id)).ok).toBe(true);
    expect(await library.list()).toHaveLength(0);
  });

  it('keeps per-model load settings across reads', async () => {
    await gguf('preset.gguf');
    const [model] = await library.list();

    await library.savePreset(model.id, { contextTokens: 16384, kvCacheDtype: 'q8_0', budgetFraction: 0.6 });
    const [reloaded] = await library.list();
    expect(reloaded.preset).toEqual({ contextTokens: 16384, kvCacheDtype: 'q8_0', budgetFraction: 0.6 });
  });

  it('reports total disk use across the library', async () => {
    await gguf('a.gguf');
    await gguf('b.gguf');
    const models = await library.list();
    expect(await library.diskUsage()).toBe(models.reduce((n, m) => n + m.sizeBytes, 0));
  });

  it('survives a models folder that does not exist yet', async () => {
    const empty = createLibrary({ modelsDir: () => join(dir, 'not-created') });
    expect(await empty.list()).toEqual([]);
  });
});
