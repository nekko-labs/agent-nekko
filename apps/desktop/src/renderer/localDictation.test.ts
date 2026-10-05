import { describe, expect, it, vi } from 'vitest';
import { createLocalRecognition } from './localDictation.js';

describe('local-only recognition', () => {
  it('rejects legacy browser recognition without starting it', async () => {
    const legacy = vi.fn();
    await expect(createLocalRecognition('en-US', { webkitSpeechRecognition: legacy })).rejects.toThrow('not supported');
    expect(legacy).not.toHaveBeenCalled();
  });
  it('rejects unavailable/downloadable packs without a cloud fallback', async () => {
    const recognition = Object.assign(vi.fn(), { available: vi.fn(async () => 'downloadable') });
    await expect(createLocalRecognition('en-US', { SpeechRecognition: recognition })).rejects.toThrow('not installed');
    expect(recognition.available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
    expect(recognition).not.toHaveBeenCalled();
  });
  it('enforces local processing before a caller can start recognition', async () => {
    class Recognition {
      static available = vi.fn(async () => 'available');
      processLocally = false;
      lang = '';
      continuous = false;
      interimResults = false;
    }
    const recognition = await createLocalRecognition('en-US', { SpeechRecognition: Recognition });
    expect(recognition.processLocally).toBe(true);
    expect(recognition.lang).toBe('en-US');
    expect(recognition.continuous).toBe(true);
  });
  it('rejects an implementation that cannot enforce processLocally', async () => {
    class Recognition { static available = vi.fn(async () => 'available'); }
    await expect(createLocalRecognition('en-US', { SpeechRecognition: Recognition })).rejects.toThrow('cannot enforce');
  });
});
