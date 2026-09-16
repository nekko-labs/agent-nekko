import { open } from 'fs/promises';

/**
 * A GGUF header reader, just far enough to answer the fit planner's questions.
 *
 * This is the piece that upgrades a downloaded model from a guess to a fact. The
 * planner needs four numbers (block count, KV head count, head dimension, trained
 * context) and none of the HTTP APIs we talk to publish all four. They are all in
 * the file's own metadata, ahead of the tensor data, so reading the first part of
 * the file is enough: we never touch the gigabytes behind it.
 *
 * Format (v2/v3): a 4-byte magic, a u32 version, a u64 tensor count, a u64
 * metadata-pair count, then that many pairs of (string key, u32 type, value).
 * Keys are architecture-prefixed exactly as in Ollama's `model_info`
 * (`llama.block_count`, `qwen3.attention.head_count_kv`), which is why the lookup
 * here matches on the suffix and a new architecture needs no code change.
 */

const MAGIC = 0x46554747; // "GGUF" little-endian
/** Metadata sits at the front; a model whose header exceeds this is malformed. */
const MAX_HEADER_BYTES = 16 * 1024 * 1024;

export interface GgufMetadata {
  architecture?: string;
  layers?: number;
  kvHeads?: number;
  headDim?: number;
  maxContext?: number;
  /** From `general.file_type`, mapped to the familiar quant names. */
  quantization?: string;
  parameterSize?: string;
  name?: string;
}

/** GGUF value type tags, in the order the format defines them. */
const enum T {
  UINT8,
  INT8,
  UINT16,
  INT16,
  UINT32,
  INT32,
  FLOAT32,
  BOOL,
  STRING,
  ARRAY,
  UINT64,
  INT64,
  FLOAT64,
}

/**
 * `general.file_type` values. Only the ones a user is likely to download are
 * named; anything else reports as the raw id rather than as a wrong label.
 */
const FILE_TYPES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  36: 'TQ1_0',
  37: 'TQ2_0',
  // MXFP4, as shipped by gpt-oss.
  38: 'MXFP4',
};

/**
 * Read a GGUF file's metadata, or null when the file is not a readable GGUF.
 *
 * Never throws: a truncated download and a JPEG renamed to `.gguf` are both just
 * "we could not read this", and the caller's fallback (size on disk, `unknown`
 * verdict) is already correct for that case.
 */
export async function readGgufMetadata(path: string): Promise<GgufMetadata | null> {
  let handle;
  try {
    handle = await open(path, 'r');
    const head = Buffer.alloc(Math.min(MAX_HEADER_BYTES, 4 * 1024 * 1024));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (bytesRead < 24) return null;
    const parsed = parse(head.subarray(0, bytesRead));
    if (parsed !== 'truncated') return parsed;

    // A big vocabulary (a 256k-token tokenizer array) can push the geometry keys
    // past the first read. Widen once rather than reading the whole file.
    const wide = Buffer.alloc(MAX_HEADER_BYTES);
    const second = await handle.read(wide, 0, wide.length, 0);
    const retry = parse(wide.subarray(0, second.bytesRead));
    return retry === 'truncated' ? null : retry;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Parse a header buffer. `'truncated'` means "read more and try again". */
function parse(buf: Buffer): GgufMetadata | null | 'truncated' {
  if (buf.readUInt32LE(0) !== MAGIC) return null;
  const version = buf.readUInt32LE(4);
  if (version < 2 || version > 3) return null;

  const r = new Reader(buf, 8);
  try {
    r.u64(); // tensor count, not needed here
    const pairs = Number(r.u64());
    if (!Number.isSafeInteger(pairs) || pairs < 0 || pairs > 100_000) return null;

    const kv = new Map<string, number | string>();
    for (let i = 0; i < pairs; i++) {
      const key = r.string();
      const value = r.value();
      // Arrays (tokenizer vocabularies) are skipped by the reader, which returns
      // undefined for them. Nothing the planner needs is an array.
      if (typeof value === 'number' || typeof value === 'string') kv.set(key, value);
    }
    return toMetadata(kv);
  } catch (e) {
    return (e as Error).message === 'eof' ? 'truncated' : null;
  }
}

function toMetadata(kv: Map<string, number | string>): GgufMetadata {
  const arch = str(kv, 'general.architecture');
  const heads = num(kv, 'attention.head_count');
  const embedding = num(kv, 'embedding_length');
  // Some architectures publish the head dimension directly; prefer it, because
  // embedding / heads is wrong for models whose head dim is not that ratio
  // (Gemma 3 among them).
  const headDim = num(kv, 'attention.key_length') ?? (embedding && heads ? embedding / heads : undefined);
  const fileType = num(kv, 'general.file_type');

  return {
    architecture: arch,
    name: str(kv, 'general.name'),
    layers: num(kv, 'block_count'),
    // A model with no grouped-query attention publishes no `head_count_kv`; there
    // the KV head count is the attention head count.
    kvHeads: num(kv, 'attention.head_count_kv') ?? heads,
    headDim: headDim && Number.isFinite(headDim) ? headDim : undefined,
    maxContext: num(kv, 'context_length'),
    quantization: fileType !== undefined ? (FILE_TYPES[fileType] ?? `type ${fileType}`) : undefined,
    parameterSize: str(kv, 'general.size_label'),
  };
}

/** Exact key, else the architecture-prefixed one (`llama.block_count`). */
function pick(kv: Map<string, number | string>, suffix: string): number | string | undefined {
  const exact = kv.get(suffix);
  if (exact !== undefined) return exact;
  for (const [key, value] of kv) {
    if (key.endsWith(`.${suffix}`)) return value;
  }
  return undefined;
}

function num(kv: Map<string, number | string>, suffix: string): number | undefined {
  const v = pick(kv, suffix);
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function str(kv: Map<string, number | string>, suffix: string): string | undefined {
  const v = pick(kv, suffix);
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * A cursor over the header bytes.
 *
 * Every read checks the remaining length and throws `eof` rather than letting
 * Buffer throw its own error, so the caller can tell "the header is longer than
 * what we read" apart from "this is not a GGUF".
 */
class Reader {
  constructor(
    private buf: Buffer,
    private at: number,
  ) {}

  private need(n: number): number {
    if (this.at + n > this.buf.length) throw new Error('eof');
    const start = this.at;
    this.at += n;
    return start;
  }

  u32(): number {
    return this.buf.readUInt32LE(this.need(4));
  }

  u64(): bigint {
    return this.buf.readBigUInt64LE(this.need(8));
  }

  string(): string {
    const len = Number(this.u64());
    // A sane key or value is never a gigabyte; treat that as a corrupt file
    // rather than trying to allocate it.
    if (!Number.isSafeInteger(len) || len < 0 || len > 64 * 1024 * 1024) throw new Error('bad');
    const start = this.need(len);
    return this.buf.toString('utf8', start, start + len);
  }

  /** One metadata value. Returns undefined for arrays, which are skipped whole. */
  value(): number | string | undefined {
    return this.readTyped(this.u32());
  }

  private readTyped(type: number): number | string | undefined {
    switch (type) {
      case T.UINT8:
        return this.buf.readUInt8(this.need(1));
      case T.INT8:
        return this.buf.readInt8(this.need(1));
      case T.UINT16:
        return this.buf.readUInt16LE(this.need(2));
      case T.INT16:
        return this.buf.readInt16LE(this.need(2));
      case T.UINT32:
        return this.buf.readUInt32LE(this.need(4));
      case T.INT32:
        return this.buf.readInt32LE(this.need(4));
      case T.FLOAT32:
        return this.buf.readFloatLE(this.need(4));
      case T.BOOL:
        return this.buf.readUInt8(this.need(1));
      case T.STRING:
        return this.string();
      case T.UINT64:
        return Number(this.u64());
      case T.INT64:
        return Number(this.buf.readBigInt64LE(this.need(8)));
      case T.FLOAT64:
        return this.buf.readDoubleLE(this.need(8));
      case T.ARRAY:
        this.skipArray();
        return undefined;
      default:
        // An unknown type means we no longer know where the next pair starts, so
        // there is nothing to do but stop.
        throw new Error('bad');
    }
  }

  private skipArray(): void {
    const elemType = this.u32();
    const count = Number(this.u64());
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('bad');
    const fixed = FIXED_WIDTH[elemType];
    if (fixed !== undefined) {
      this.need(fixed * count);
      return;
    }
    if (elemType === T.STRING) {
      // A 256k-entry tokenizer vocabulary walked one string at a time is still
      // only a few million bounds checks, and it is the only way to find where
      // the array ends.
      for (let i = 0; i < count; i++) this.string();
      return;
    }
    throw new Error('bad');
  }
}

const FIXED_WIDTH: Record<number, number> = {
  [T.UINT8]: 1,
  [T.INT8]: 1,
  [T.BOOL]: 1,
  [T.UINT16]: 2,
  [T.INT16]: 2,
  [T.UINT32]: 4,
  [T.INT32]: 4,
  [T.FLOAT32]: 4,
  [T.UINT64]: 8,
  [T.INT64]: 8,
  [T.FLOAT64]: 8,
};
