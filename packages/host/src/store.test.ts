import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { withDataDir } from './paths.js';
import { getSettings } from './store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('getSettings', () => {
  it('loads a settings file from before the tool-step limit was removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-store-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', maxSteps: 250 }));
    const settings = withDataDir(dir, () => getSettings());
    expect(settings.theme).toBe('dark');
    expect('maxSteps' in settings).toBe(false);
  });
});
