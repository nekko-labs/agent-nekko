import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ModelFolder } from '@agent-nekko/shared';
import { createLibrary, PRIMARY_FOLDER_ID } from './library.js';
import { folderId, knownFolderCandidates } from './folders.js';
import { listOllamaModels, modelName } from './ollama.js';
import { buildGguf, str, u32 } from './gguf-fixture.js';

/**
 * Reading models out of other apps' folders.
 *
 * The premise is that a GGUF is a GGUF whoever downloaded it, so most of this is
 * about the two things that make a borrowed folder different from ours: its
 * models must not collide with ours or with each other, and they must not be
 * deletable from here, because the file belongs to whichever app put it there.
 */

let root: string;
let primary: string;

const gguf = (path: string, name: string) =>
  writeFile(
    path,
    buildGguf([
      ['general.architecture', str('llama')],
      ['general.name', str(name)],
      ['general.file_type', u32(15)],
      ['llama.block_count', u32(32)],
    ]),
  );

const library = (folders: ModelFolder[] = []) => createLibrary({ modelsDir: () => primary, folders: () => folders });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nekko-folders-'));
  primary = join(root, 'nekko');
  await mkdir(primary, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('borrowed model folders', () => {
  it('lists models from another app alongside our own', async () => {
    const lm = join(root, 'lmstudio');
    await mkdir(join(lm, 'bartowski', 'Qwen'), { recursive: true });
    await gguf(join(primary, 'ours.gguf'), 'ours');
    await gguf(join(lm, 'bartowski', 'Qwen', 'theirs.gguf'), 'theirs');

    const models = await library([{ id: 'lmstudio', path: lm, provider: 'lmstudio', enabled: true }]).list();
    expect(models.map((m) => m.name).sort()).toEqual(['ours', 'theirs']);
  });

  it('keeps our own ids bare, so anything already saved still resolves', async () => {
    await gguf(join(primary, 'ours.gguf'), 'ours');
    const [model] = await library().list();
    expect(model.id).toBe('ours');
    expect(model.folderId).toBe(PRIMARY_FOLDER_ID);
    expect(model.managed).toBe(true);
  });

  it('prefixes a borrowed model, so two copies of one file are two rows', async () => {
    const lm = join(root, 'lmstudio');
    await mkdir(lm, { recursive: true });
    await gguf(join(primary, 'qwen.gguf'), 'qwen');
    await gguf(join(lm, 'qwen.gguf'), 'qwen');

    const models = await library([{ id: 'lmstudio', path: lm, provider: 'lmstudio', enabled: true }]).list();
    expect(models.map((m) => m.id).sort()).toEqual(['lmstudio/qwen', 'qwen']);
  });

  it('refuses to delete a file that belongs to another app', async () => {
    const lm = join(root, 'lmstudio');
    await mkdir(lm, { recursive: true });
    await gguf(join(lm, 'theirs.gguf'), 'theirs');

    const lib = library([{ id: 'lmstudio', path: lm, provider: 'lmstudio', enabled: true }]);
    const [model] = await lib.list();
    const res = await lib.remove(model.id);

    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/only reads/);
    expect(await lib.list()).toHaveLength(1);
  });

  it('skips a folder that is switched off without forgetting it', async () => {
    const lm = join(root, 'lmstudio');
    await mkdir(lm, { recursive: true });
    await gguf(join(lm, 'theirs.gguf'), 'theirs');
    const folder: ModelFolder = { id: 'lmstudio', path: lm, provider: 'lmstudio', enabled: false };

    expect(await library([folder]).list()).toHaveLength(0);
    expect(await library([{ ...folder, enabled: true }]).list()).toHaveLength(1);
  });

  it('reads one folder once when two rows point at the same place', async () => {
    // vLLM serves out of the Hugging Face cache, so its row and the cache's row
    // are the same directory under two names.
    const cache = join(root, 'hf');
    await mkdir(cache, { recursive: true });
    await gguf(join(cache, 'shared.gguf'), 'shared');

    const models = await library([
      { id: 'huggingface', path: cache, provider: 'huggingface', enabled: true },
      { id: 'vllm', path: cache, provider: 'vllm', enabled: true },
    ]).list();
    expect(models).toHaveLength(1);
  });

  it('counts what each folder contributes, for the folder list', async () => {
    const lm = join(root, 'lmstudio');
    await mkdir(lm, { recursive: true });
    await gguf(join(primary, 'ours.gguf'), 'ours');
    await gguf(join(lm, 'a.gguf'), 'a');
    await gguf(join(lm, 'b.gguf'), 'b');

    const report = await library([{ id: 'lmstudio', path: lm, provider: 'lmstudio', enabled: true }]).folderReport();
    expect(report.find((f) => f.primary)?.modelCount).toBe(1);
    expect(report.find((f) => f.id === 'lmstudio')?.modelCount).toBe(2);
  });

  it('probes a folder before anyone adds it', async () => {
    const jan = join(root, 'jan');
    await mkdir(jan, { recursive: true });
    await gguf(join(jan, 'one.gguf'), 'one');
    expect((await library().probe(jan)).modelCount).toBe(1);
    expect((await library().probe(join(root, 'nope'))).modelCount).toBe(0);
  });

  it('offers a candidate path per app, for the platform it is asked about', () => {
    const win = knownFolderCandidates('win32').map((c) => c.provider);
    expect(win).toContain('ollama');
    expect(win).toContain('lmstudio');
    expect(win).toContain('huggingface');
    for (const c of knownFolderCandidates('darwin')) expect(c.paths.length).toBeGreaterThan(0);
  });

  it('gives a custom folder a stable id derived from its path', () => {
    expect(folderId(undefined, 'D:\\models')).toBe(folderId(undefined, 'D:\\models'));
    expect(folderId(undefined, 'D:\\models')).not.toBe(folderId(undefined, 'E:\\models'));
    expect(folderId('ollama', 'anywhere')).toBe('ollama');
  });
});

describe('ollama', () => {
  /** A manifest and the blob it points at, as Ollama files them. */
  async function seedOllama(dir: string, name: string, tag: string, digest: string) {
    const manifest = join(dir, 'manifests', 'registry.ollama.ai', 'library', name);
    await mkdir(manifest, { recursive: true });
    await mkdir(join(dir, 'blobs'), { recursive: true });
    await writeFile(
      join(manifest, tag),
      JSON.stringify({
        layers: [
          { mediaType: 'application/vnd.ollama.image.template', digest: 'sha256:aaa' },
          { mediaType: 'application/vnd.ollama.image.model', digest: `sha256:${digest}` },
        ],
      }),
    );
    await gguf(join(dir, 'blobs', `sha256-${digest}`), name);
  }

  it('names a hashed blob from the manifest that points at it', async () => {
    const dir = join(root, 'ollama');
    await seedOllama(dir, 'llama3.2', 'latest', 'deadbeef');

    const models = await listOllamaModels(dir);
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('llama3.2:latest');
    expect(models[0].path).toContain('sha256-deadbeef');
  });

  it('drops the default registry and the library namespace, as ollama does', () => {
    const root_ = join('x', 'manifests');
    expect(modelName(root_, join(root_, 'registry.ollama.ai', 'library', 'qwen3', '8b'))).toBe('qwen3:8b');
    expect(modelName(root_, join(root_, 'registry.ollama.ai', 'someone', 'model', 'latest'))).toBe('someone/model:latest');
  });

  it('reads nothing from a folder that is not an ollama store', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain, { recursive: true });
    await gguf(join(plain, 'a.gguf'), 'a');
    expect(await listOllamaModels(plain)).toEqual([]);
  });

  it('surfaces ollama models in the library under their real names', async () => {
    const dir = join(root, 'ollama');
    await seedOllama(dir, 'gemma3', 'latest', 'c0ffee');

    const models = await library([{ id: 'ollama', path: dir, provider: 'ollama', enabled: true }]).list();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('gemma3:latest');
    expect(models[0].id).toBe('ollama/gemma3:latest');
    expect(models[0].managed).toBe(false);
    // The header still gets read, so the fit planner has real geometry for it.
    expect(models[0].layers).toBe(32);
  });
});
