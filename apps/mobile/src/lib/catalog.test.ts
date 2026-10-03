import { describe, expect, it } from 'vitest';
import { GB, PHONE_MODELS, findModel, fitFor, formatBytes, modelUrl, recommendedModel } from './catalog';

describe('phone model catalog', () => {
  it('has unique ids and GGUF files', () => {
    expect(new Set(PHONE_MODELS.map((m) => m.id)).size).toBe(PHONE_MODELS.length);
    for (const m of PHONE_MODELS) {
      expect(m.file).toMatch(/\.gguf$/);
      expect(modelUrl(m)).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/main\/.+\.gguf\?download=true$/);
    }
  });

  it('fits models to phone memory', () => {
    const tiny = findModel('qwen3.5-0.8b')!;
    const big = findModel('gemma-4-e4b')!;
    expect(fitFor(tiny, 4 * GB)).toBe('great');
    expect(fitFor(big, 4 * GB)).toBe('too-big');
    expect(fitFor(big, 12 * GB)).toBe('ok');
    expect(fitFor(big, 16 * GB)).toBe('great');
  });

  it('recommends a quick everyday model, not the biggest that squeezes in', () => {
    expect(recommendedModel(3 * GB).id).toBe('qwen3.5-0.8b');
    expect(recommendedModel(8 * GB).id).toBe('qwen3.5-2b');
    expect(recommendedModel(12 * GB).id).toBe('qwen3.5-2b');
    expect(recommendedModel(null)).toBeTruthy();
  });

  it('formats sizes', () => {
    expect(formatBytes(532_517_120)).toBe('508 MB');
    expect(formatBytes(2.5 * GB)).toBe('2.5 GB');
  });
});
