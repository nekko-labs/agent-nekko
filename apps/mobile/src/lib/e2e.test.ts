import { describe, expect, it } from 'vitest';
// The agent's implementation (WebCrypto). The phone must interoperate with it
// byte for byte, in both directions.
import * as agent from '../../../../packages/shared/src/e2e';
import { deriveKeyBytes, fromB64, fromHex, open, seal, toB64, toHex, utf8Decode } from './e2e';

const SECRET = '0123456789abcdef0123456789abcdef';
const ROOM = 'a1b2c3d4e5f60718';

describe('phone E2E matches the agent', () => {
  it('derives the same key as WebCrypto PBKDF2', async () => {
    const bytes = await deriveKeyBytes(SECRET, ROOM);
    expect(bytes.length).toBe(32);
    const webKey = await agent.deriveKey(SECRET, ROOM);
    // Decrypting a phone-sealed frame with the agent's key proves the keys match.
    const blob = seal(bytes, { type: 'hello', deviceId: 'x' });
    expect(await agent.open(webKey, blob)).toEqual({ type: 'hello', deviceId: 'x' });
  });

  it('opens frames the agent sealed', async () => {
    const bytes = await deriveKeyBytes(SECRET, ROOM);
    const webKey = await agent.deriveKey(SECRET, ROOM);
    const value = { type: 'event', channel: 'agent:event', payload: { type: 'text', delta: 'héllo ✓ 猫' } };
    expect(open(bytes, await agent.seal(webKey, value))).toEqual(value);
  });

  it('rejects a tampered frame and a wrong key', async () => {
    const bytes = await deriveKeyBytes(SECRET, ROOM);
    const blob = seal(bytes, { a: 1 });
    const raw = fromB64(blob);
    raw[raw.length - 1] ^= 1;
    expect(() => open(bytes, toB64(raw))).toThrow();
    const other = await deriveKeyBytes(SECRET, 'ffffffffffffffff');
    expect(() => open(other, blob)).toThrow();
  });

  it('round-trips base64 and hex for every length remainder', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 100, 1001]) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff);
      expect(fromB64(toB64(b))).toEqual(b);
      expect(toB64(b)).toBe(Buffer.from(b).toString('base64'));
      expect(fromHex(toHex(b))).toEqual(b);
    }
  });

  it('decodes UTF-8 without TextDecoder', () => {
    const s = 'plain, héllo, 猫, 🐈‍⬛';
    expect(utf8Decode(new TextEncoder().encode(s))).toBe(s);
  });
});
