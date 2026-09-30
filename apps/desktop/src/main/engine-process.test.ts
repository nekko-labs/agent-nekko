import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDaemon } from './engine-process.js';

const app = (over: Partial<{ isPackaged: boolean; appPath: string; resourcesPath: string }> = {}) => ({
  app: { isPackaged: false, appPath: '/nowhere/apps/desktop', userData: '/u', version: '0', ...over },
});

describe('finding the engine daemon', () => {
  const saved = process.env.NEKKOD_PATH;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEKKOD_PATH;
    else process.env.NEKKOD_PATH = saved;
  });

  it('uses an explicit override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekkod-find-'));
    const bin = join(dir, 'nekkod-custom');
    writeFileSync(bin, '');
    process.env.NEKKOD_PATH = bin;
    expect(findDaemon(app())).toBe(bin);
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a packaged binary under resources/bin', () => {
    delete process.env.NEKKOD_PATH;
    const res = mkdtempSync(join(tmpdir(), 'nekkod-res-'));
    const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';
    const bin = join(res, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, exe), '');
    expect(findDaemon(app({ isPackaged: true, resourcesPath: res }))).toBe(join(bin, exe));
    rmSync(res, { recursive: true, force: true });
  });

  it('reports none rather than guessing, so the app falls back to the TS backend', () => {
    delete process.env.NEKKOD_PATH;
    expect(findDaemon(app())).toBeNull();
  });
});
