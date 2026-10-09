import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('image and hardware regression boundaries', () => {
  it('keeps the prompt until image prerequisites have been checked', () => {
    const text = source('./ChatPane.tsx');
    const turn = text.slice(text.indexOf('const sendImage ='), text.indexOf('const send ='));
    expect(turn.indexOf('engineImageCompanions')).toBeLessThan(turn.indexOf("setDraft('')"));
    expect(turn).toContain('!runtime.diffusionInstall?.binPath');
    expect(turn).toContain('setup && !setup.ready');
  });
  it('polls hardware twice as often without a longer GPU cache', () => {
    expect(source('./ResourceMonitor.tsx')).toContain('const POLL_MS = 2000;');
    const gpu = source('../../../../../packages/host/src/gpu.ts');
    expect(gpu).toContain('const TTL_MS = 1000;');
    expect(gpu).toContain('if (inFlight) return inFlight;');
  });
  it('keeps SVG preview in the explicit file viewer, not the raster reader', () => {
    expect(source('./Markdown.tsx')).toContain('!file.binary && !file.truncated');
    expect(source('./FilePane.tsx')).toContain('title="Download a copy of this file"');
  });
});
