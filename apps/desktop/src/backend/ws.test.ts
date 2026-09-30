import { describe, expect, it } from 'vitest';
import { acceptKey, encodeFrame, FrameReader, OP_BINARY, OP_CLOSE, OP_PING, OP_TEXT } from './ws.js';

/** A client frame: always masked, per RFC 6455. */
function clientFrame(payload: Buffer, opcode: number, fin = true): Buffer {
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const n = payload.length;
  let header: Buffer;
  if (n < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | n]);
  else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, mask, masked]);
}

describe('websocket frames', () => {
  it('computes the RFC 6455 accept key', () => {
    // The worked example from the RFC.
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('encodes all three length forms', () => {
    expect(encodeFrame(Buffer.alloc(5)).subarray(0, 2)).toEqual(Buffer.from([0x81, 5]));
    expect(encodeFrame(Buffer.alloc(300))[1]).toBe(126);
    expect(encodeFrame(Buffer.alloc(70000), OP_BINARY)[0]).toBe(0x82);
    expect(encodeFrame(Buffer.alloc(70000))[1]).toBe(127);
  });

  it('unmasks a text message', () => {
    const r = new FrameReader();
    const [m] = r.push(clientFrame(Buffer.from('{"id":1}'), OP_TEXT));
    expect(m.opcode).toBe(OP_TEXT);
    expect(m.payload.toString()).toBe('{"id":1}');
  });

  it('waits for a frame split across chunks', () => {
    const r = new FrameReader();
    const frame = clientFrame(Buffer.from('x'.repeat(1000)), OP_TEXT);
    expect(r.push(frame.subarray(0, 3))).toEqual([]);
    expect(r.push(frame.subarray(3, 500))).toEqual([]);
    const [m] = r.push(frame.subarray(500));
    expect(m.payload.length).toBe(1000);
  });

  it('joins fragments and passes control frames through between them', () => {
    const r = new FrameReader();
    const out = r.push(
      Buffer.concat([
        clientFrame(Buffer.from('hel'), OP_TEXT, false),
        clientFrame(Buffer.from('ping'), OP_PING),
        clientFrame(Buffer.from('lo'), 0, true),
        clientFrame(Buffer.alloc(0), OP_CLOSE),
      ]),
    );
    expect(out.map((m) => m.opcode)).toEqual([OP_PING, OP_TEXT, OP_CLOSE]);
    expect(out[1].payload.toString()).toBe('hello');
  });

  it('reads a large binary message', () => {
    const r = new FrameReader();
    const big = Buffer.alloc(200_000, 7);
    const [m] = r.push(clientFrame(big, OP_BINARY));
    expect(m.payload.equals(big)).toBe(true);
  });
});
