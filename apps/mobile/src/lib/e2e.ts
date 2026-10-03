/**
 * End-to-end encryption for relayed traffic, wire-compatible with
 * `packages/shared/src/e2e.ts` (the desktop/agent side, which uses WebCrypto).
 *
 * Hermes has no `crypto.subtle`, so this is the same construction in pure JS:
 * PBKDF2-SHA256 (100k iterations, salt `nekko-relay:<room>`) derives an
 * AES-256-GCM key, and a sealed frame is base64(iv ‖ ciphertext ‖ tag), which
 * is exactly what WebCrypto's AES-GCM produces. `e2e.test.ts` pins both
 * directions against the shared implementation.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';

export type RandomBytes = (n: number) => Uint8Array;

const defaultRandom: RandomBytes = (n) => {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
};

const enc = new TextEncoder();
// Hermes ships TextEncoder but not always TextDecoder; frames are UTF-8 JSON.
const decode: (b: Uint8Array) => string =
  typeof TextDecoder === 'function' ? (b) => new TextDecoder().decode(b) : utf8Decode;

/** Derive the 32-byte room key. Slow on purpose (~1s on a phone); cache it. */
export async function deriveKeyBytes(secret: string, room: string): Promise<Uint8Array> {
  // PROTOCOL CONSTANT: must match shared/e2e.ts deriveKey exactly.
  return pbkdf2Async(sha256, enc.encode(secret), enc.encode(`nekko-relay:${room}`), {
    c: 100_000,
    dkLen: 32,
    asyncTick: 20,
  });
}

/** Encrypt a JSON-serializable value into a base64 string (iv ‖ ct ‖ tag). */
export function seal(key: Uint8Array, value: unknown, random: RandomBytes = defaultRandom): string {
  const iv = random(12);
  const ct = gcm(key, iv).encrypt(enc.encode(JSON.stringify(value)));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toB64(packed);
}

/** Decrypt a frame produced by seal() here or on the agent. Throws if tampered. */
export function open<T = unknown>(key: Uint8Array, blob: string): T {
  const packed = fromB64(blob);
  const pt = gcm(key, packed.slice(0, 12)).decrypt(packed.slice(12));
  return JSON.parse(decode(pt)) as T;
}

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Hand-rolled so large frames don't go through String.fromCharCode + btoa,
// which is quadratic-ish on Hermes for multi-megabyte transcripts.
export function toB64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

const LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function fromB64(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | LOOKUP[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** UTF-8 → string, for runtimes without TextDecoder. Invalid bytes become U+FFFD. */
export function utf8Decode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    if (c < 0x80) cp = c;
    else if (c >= 0xc2 && c < 0xe0 && i < b.length) cp = ((c & 0x1f) << 6) | (b[i++] & 0x3f);
    else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) cp = ((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
    else if (c >= 0xf0 && c < 0xf5 && i + 2 < b.length)
      cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f);
    else cp = 0xfffd;
    out += String.fromCodePoint(cp);
  }
  return out;
}
