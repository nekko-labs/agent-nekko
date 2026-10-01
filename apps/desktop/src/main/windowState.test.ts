import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWindowBounds, saveWindowBounds, setWindowStateDir } from './windowState.js';

describe('window state', () => {
  it('round-trips bounds through the directory main sets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-window-'));
    setWindowStateDir(dir);
    saveWindowBounds({ width: 1500, height: 900, x: 10, y: 20 });
    expect(loadWindowBounds()).toEqual({ width: 1500, height: 900, x: 10, y: 20 });
    rmSync(dir, { recursive: true, force: true });
  });
});
