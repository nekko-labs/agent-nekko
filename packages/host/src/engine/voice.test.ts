import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateVoiceModel, validateVoiceWav, VOICE_BUILDS } from './voice.js';

function wav() {
  const b = Buffer.alloc(46); b.write('RIFF'); b.writeUInt32LE(38, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(2, 40); return [...b];
}
describe('managed voice input safety', () => {
  it('accepts bounded mono PCM and rejects arbitrary input', () => {
    expect(validateVoiceWav(wav()).length).toBe(46);
    expect(() => validateVoiceWav([])).toThrow();
    const wrong = wav(); wrong[24] = 1; expect(() => validateVoiceWav(wrong)).toThrow();
    expect(() => validateVoiceWav(new Array(2000000).fill(0))).toThrow();
  });
  it('pins every downloadable runtime to SHA256', () => {
    expect(Object.values(VOICE_BUILDS).every(b => /^[a-f0-9]{64}$/.test(b.hash))).toBe(true);
  });
  it('rejects LLM GGUF models and accepts GGML header', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-test-'));
    try {
      const path = join(dir, 'model.bin'); await writeFile(path, 'GGUF'); await expect(validateVoiceModel(path)).rejects.toThrow('GGML');
      const header = Buffer.alloc(4); header.writeUInt32LE(0x67676d6c); await writeFile(path, header); await expect(validateVoiceModel(path)).resolves.toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
