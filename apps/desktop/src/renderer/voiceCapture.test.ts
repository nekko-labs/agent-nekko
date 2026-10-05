import { describe, expect, it } from 'vitest';
import { pcmWav } from './voiceCapture.js';

describe('local PCM recording', () => {
  it('encodes mono 16kHz PCM without an external converter', () => {
    const bytes = pcmWav(new Float32Array(48000).fill(0.5), 48000);
    const v = new DataView(Uint8Array.from(bytes).buffer);
    expect(bytes.length).toBe(32044);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getInt16(44, true)).toBe(16383);
  });
  it('clamps excessive amplitude', () => {
    const v = new DataView(Uint8Array.from(pcmWav(new Float32Array([-2, 2]), 16000)).buffer);
    expect(v.getInt16(44, true)).toBe(-32768);
    expect(v.getInt16(46, true)).toBe(32767);
  });
});
