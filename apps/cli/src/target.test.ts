import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCliLink, resolveTarget } from './lib.js';

/**
 * Where the CLI points, in precedence order. Runs against a throwaway data
 * directory so the real ~/.nekko link file never decides a result here.
 */
describe('resolveTarget', () => {
  const saved = { ...process.env };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-link-'));
    for (const k of Object.keys(process.env)) if (/^NEKKO_/.test(k)) delete process.env[k];
    process.env.NEKKO_DATA_DIR = dir;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const link = (enabled: boolean) =>
    writeFileSync(
      join(dir, 'cli-link.json'),
      JSON.stringify({ url: 'http://127.0.0.1:1439', token: 'app-token', enabled, updatedAt: 1 }),
    );

  it('runs locally when nothing points anywhere', () => {
    expect(resolveTarget()).toEqual({ source: 'local' });
  });

  it('follows the app when it left a link and is serving', () => {
    link(true);
    expect(readCliLink(dir)?.token).toBe('app-token');
    expect(resolveTarget()).toEqual({ url: 'http://127.0.0.1:1439', token: 'app-token', source: 'app' });
  });

  it('ignores a link the app marked as not serving', () => {
    link(false);
    expect(resolveTarget().source).toBe('local');
  });

  it('lets the environment beat the link, and a flag beat both', () => {
    link(true);
    process.env.NEKKO_URL = 'http://env:1';
    process.env.NEKKO_TOKEN = 'env-token';
    expect(resolveTarget()).toEqual({ url: 'http://env:1', token: 'env-token', source: 'env' });
    expect(resolveTarget({ url: 'http://flag:2', token: 'flag-token' })).toEqual({
      url: 'http://flag:2',
      token: 'flag-token',
      source: 'flag',
    });
  });
});

describe('a link left by an app that is gone', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is not a target once its process has exited', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-deadlink-'));
    for (const k of Object.keys(process.env)) if (/^NEKKO_/.test(k)) delete process.env[k];
    process.env.NEKKO_DATA_DIR = dir;
    const write = (pid: number) =>
      writeFileSync(join(dir, 'cli-link.json'), JSON.stringify({ url: 'http://127.0.0.1:1439', token: 't', enabled: true, updatedAt: 1, pid }));
    write(process.pid);
    expect(resolveTarget().source).toBe('app');
    // A pid far above anything a real process gets.
    write(2 ** 30);
    expect(resolveTarget().source).toBe('local');
  });
});
