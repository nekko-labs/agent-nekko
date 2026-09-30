import { createHash } from 'node:crypto';

/**
 * The server half of RFC 6455, enough for the backend's two sockets.
 *
 * The local API server (`main/api-server.ts`) only ever writes events and
 * reads control frames; the backend also has to read requests, so this adds a
 * full frame reader (masking, the three length forms, fragmentation). Still no
 * dependency: the protocol is small and exactly specified.
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

/** The `Sec-WebSocket-Accept` value for a client's key. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(clientKey + WS_GUID).digest('base64');
}

/** One unmasked frame, as a server sends it. */
export function encodeFrame(payload: Buffer, opcode = OP_TEXT): Buffer {
  const n = payload.length;
  let header: Buffer;
  if (n < 126) {
    header = Buffer.from([0x80 | opcode, n]);
  } else if (n < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(n, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([header, payload]);
}

export interface WsMessage {
  opcode: number;
  payload: Buffer;
}

/** Largest message accepted, matching the HTTP body limit. */
const MAX_MESSAGE = 25 * 1024 * 1024;

/**
 * Turns the byte stream a client sends into whole messages. Continuation
 * frames are joined; control frames (close, ping, pong) are returned as they
 * arrive, even between the fragments of a data message.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentSize = 0;

  push(chunk: Buffer): WsMessage[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: WsMessage[] = [];
    let offset = 0;
    while (offset + 2 <= this.buffer.length) {
      const b0 = this.buffer[offset];
      const b1 = this.buffer[offset + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let header = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 4) break;
        length = this.buffer.readUInt16BE(offset + 2);
        header = 4;
      } else if (length === 127) {
        if (this.buffer.length < offset + 10) break;
        length = Number(this.buffer.readBigUInt64BE(offset + 2));
        header = 10;
      }
      if (length > MAX_MESSAGE) throw new Error('websocket frame too large');
      const maskAt = offset + header;
      const dataAt = maskAt + (masked ? 4 : 0);
      if (this.buffer.length < dataAt + length) break;
      const payload = Buffer.from(this.buffer.subarray(dataAt, dataAt + length));
      if (masked) {
        const mask = this.buffer.subarray(maskAt, maskAt + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      offset = dataAt + length;

      if (opcode >= 0x8) {
        out.push({ opcode, payload });
        continue;
      }
      if (opcode !== 0) {
        this.fragments = [];
        this.fragmentSize = 0;
        this.fragmentOpcode = opcode;
      }
      this.fragments.push(payload);
      this.fragmentSize += payload.length;
      if (this.fragmentSize > MAX_MESSAGE) throw new Error('websocket message too large');
      if (fin) {
        out.push({ opcode: this.fragmentOpcode, payload: Buffer.concat(this.fragments) });
        this.fragments = [];
        this.fragmentSize = 0;
      }
    }
    this.buffer = offset ? this.buffer.subarray(offset) : this.buffer;
    return out;
  }
}
