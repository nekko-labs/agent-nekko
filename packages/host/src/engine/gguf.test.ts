import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { readGgufMetadata } from './gguf.js';
import { buildGguf, f32, str, strings, u32 } from './gguf-fixture.js';

/**
 * The reader's whole job is to be right or say nothing. These tests are mostly
 * about the second half: a file we cannot parse must come back null so the
 * planner answers `unknown`, never a plausible-looking number.
 */

let dir: string;
const write = async (name: string, buf: Buffer): Promise<string> => {
  const path = join(dir, name);
  await writeFile(path, buf);
  return path;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nekko-gguf-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readGgufMetadata', () => {
  it('reads architecture-prefixed geometry', async () => {
    const path = await write(
      'llama.gguf',
      buildGguf([
        ['general.architecture', str('llama')],
        ['general.name', str('Llama 3.1 8B Instruct')],
        ['general.file_type', u32(15)],
        ['general.size_label', str('8B')],
        ['llama.block_count', u32(32)],
        ['llama.attention.head_count', u32(32)],
        ['llama.attention.head_count_kv', u32(8)],
        ['llama.embedding_length', u32(4096)],
        ['llama.context_length', u32(131072)],
      ]),
    );

    expect(await readGgufMetadata(path)).toEqual({
      architecture: 'llama',
      name: 'Llama 3.1 8B Instruct',
      layers: 32,
      kvHeads: 8,
      headDim: 128,
      maxContext: 131072,
      quantization: 'Q4_K_M',
      parameterSize: '8B',
    });
  });

  it('prefers a published key length over embedding / heads', async () => {
    // Gemma 3's head dimension is not embedding / head_count, so deriving it
    // would overstate the KV cache by a third.
    const path = await write(
      'gemma.gguf',
      buildGguf([
        ['general.architecture', str('gemma3')],
        ['gemma3.block_count', u32(48)],
        ['gemma3.attention.head_count', u32(16)],
        ['gemma3.attention.head_count_kv', u32(8)],
        ['gemma3.attention.key_length', u32(256)],
        ['gemma3.embedding_length', u32(3840)],
      ]),
    );

    const meta = await readGgufMetadata(path);
    expect(meta?.headDim).toBe(256);
    expect(meta?.kvHeads).toBe(8);
  });

  it('falls back to the attention head count when there is no grouped-query key', async () => {
    const path = await write(
      'mha.gguf',
      buildGguf([
        ['general.architecture', str('gpt2')],
        ['gpt2.block_count', u32(12)],
        ['gpt2.attention.head_count', u32(12)],
        ['gpt2.embedding_length', u32(768)],
      ]),
    );

    const meta = await readGgufMetadata(path);
    expect(meta?.kvHeads).toBe(12);
    expect(meta?.headDim).toBe(64);
  });

  it('skips a large string array to reach the keys behind it', async () => {
    // A 200k-token vocabulary is the realistic shape, and the naive parser walks
    // straight off the end of it.
    const vocabulary = Array.from({ length: 5000 }, (_, i) => `token_${i}`);
    const path = await write(
      'vocab.gguf',
      buildGguf([
        ['general.architecture', str('qwen3')],
        ['tokenizer.ggml.tokens', strings(vocabulary)],
        ['qwen3.block_count', u32(36)],
        ['qwen3.attention.head_count', u32(32)],
        ['qwen3.attention.head_count_kv', u32(8)],
        ['qwen3.embedding_length', u32(4096)],
      ]),
    );

    const meta = await readGgufMetadata(path);
    expect(meta?.layers).toBe(36);
    expect(meta?.kvHeads).toBe(8);
  });

  it('reads float and 64-bit values without losing the following pairs', async () => {
    const path = await write(
      'mixed.gguf',
      buildGguf([
        ['general.architecture', str('llama')],
        ['llama.rope.freq_base', f32(500000)],
        ['llama.block_count', u32(80)],
      ]),
    );

    expect((await readGgufMetadata(path))?.layers).toBe(80);
  });

  it('reports an unknown file type as its raw id rather than a wrong name', async () => {
    const path = await write(
      'exotic.gguf',
      buildGguf([
        ['general.architecture', str('llama')],
        ['general.file_type', u32(199)],
        ['llama.block_count', u32(1)],
      ]),
    );

    expect((await readGgufMetadata(path))?.quantization).toBe('type 199');
  });

  it('returns null for a file that is not a GGUF', async () => {
    expect(await readGgufMetadata(await write('nope.gguf', Buffer.from('this is a text file')))).toBeNull();
  });

  it('returns null for a truncated GGUF', async () => {
    const full = buildGguf([
      ['general.architecture', str('llama')],
      ['llama.block_count', u32(32)],
    ]);
    // A download killed partway through: the header says there are pairs, and the
    // bytes for them are not there.
    expect(await readGgufMetadata(await write('cut.gguf', full.subarray(0, 40)))).toBeNull();
  });

  it('returns null for an unsupported version', async () => {
    const path = await write('v1.gguf', buildGguf([['general.architecture', str('llama')]], 1));
    expect(await readGgufMetadata(path)).toBeNull();
  });

  it('returns null for a file that does not exist', async () => {
    expect(await readGgufMetadata(join(dir, 'absent.gguf'))).toBeNull();
  });

  it('leaves missing fields undefined rather than guessing them', async () => {
    const path = await write('bare.gguf', buildGguf([['general.architecture', str('mystery')]]));
    const meta = await readGgufMetadata(path);
    expect(meta).not.toBeNull();
    expect(meta?.layers).toBeUndefined();
    expect(meta?.kvHeads).toBeUndefined();
    expect(meta?.maxContext).toBeUndefined();
  });
});
