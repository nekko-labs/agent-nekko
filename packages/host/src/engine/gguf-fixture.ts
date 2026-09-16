/**
 * A GGUF header builder, for tests.
 *
 * Kept beside the reader rather than inside a test file because two test files
 * need it, and because a fixture that is written by hand once and read by the
 * real parser is a better check of the format than a recorded byte blob nobody
 * can edit.
 */

const MAGIC = 0x46554747;

type Value = { type: 'string'; value: string } | { type: 'u32'; value: number } | { type: 'u64'; value: number } | { type: 'f32'; value: number } | { type: 'strings'; value: string[] };

export function str(value: string): Value {
  return { type: 'string', value };
}
export function u32(value: number): Value {
  return { type: 'u32', value };
}
export function u64(value: number): Value {
  return { type: 'u64', value };
}
export function f32(value: number): Value {
  return { type: 'f32', value };
}
/** A string array, as tokenizer vocabularies are: the reader must skip these. */
export function strings(value: string[]): Value {
  return { type: 'strings', value };
}

export function buildGguf(pairs: Array<[string, Value]>, version = 3): Buffer {
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(24);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(version, 4);
  head.writeBigUInt64LE(0n, 8); // tensor count
  head.writeBigUInt64LE(BigInt(pairs.length), 16);
  chunks.push(head);

  for (const [key, value] of pairs) {
    chunks.push(ggufString(key));
    chunks.push(encodeValue(value));
  }
  // A little trailing "tensor data" so the file is not exactly its header.
  chunks.push(Buffer.alloc(64));
  return Buffer.concat(chunks);
}

function encodeValue(value: Value): Buffer {
  switch (value.type) {
    case 'string': {
      const tag = Buffer.alloc(4);
      tag.writeUInt32LE(8, 0);
      return Buffer.concat([tag, ggufString(value.value)]);
    }
    case 'u32': {
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(4, 0);
      buf.writeUInt32LE(value.value, 4);
      return buf;
    }
    case 'u64': {
      const buf = Buffer.alloc(12);
      buf.writeUInt32LE(10, 0);
      buf.writeBigUInt64LE(BigInt(value.value), 4);
      return buf;
    }
    case 'f32': {
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(6, 0);
      buf.writeFloatLE(value.value, 4);
      return buf;
    }
    case 'strings': {
      const header = Buffer.alloc(16);
      header.writeUInt32LE(9, 0); // ARRAY
      header.writeUInt32LE(8, 4); // of STRING
      header.writeBigUInt64LE(BigInt(value.value.length), 8);
      return Buffer.concat([header, ...value.value.map(ggufString)]);
    }
  }
}

function ggufString(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(bytes.length), 0);
  return Buffer.concat([len, bytes]);
}
