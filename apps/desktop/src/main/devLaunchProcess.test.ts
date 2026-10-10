import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerDevLaunch } from './devLaunchProcess.js';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
describe('owned development launch receipt', () => {
  it('stops its registered app and removes only its own receipt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-launch-test-')); dirs.push(dir);
    const file = join(dir, 'receipt.json');
    vi.stubEnv('NEKKO_DEV_PID_FILE', file); vi.stubEnv('NEKKO_DEV_LAUNCH_TOKEN', 'owned-token'); vi.stubEnv('NEKKO_DEV_OWNER', 'owned-parent');
    let finish = () => {};
    const quit = vi.fn();
    const before = new Set(process.listeners('SIGTERM'));
    registerDevLaunch({ quit, on: (_event, handler) => { finish = handler; } });
    const stop = process.listeners('SIGTERM').find(handler => !before.has(handler))!;
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ pid: process.pid, token: 'owned-token', owner: 'owned-parent' });
    stop('SIGTERM'); expect(quit).toHaveBeenCalledOnce();
    finish(); expect(existsSync(file)).toBe(false); expect(process.listeners('SIGTERM')).not.toContain(stop);
  });
  it('quits cleanly once the launcher drops its stop file, and stops watching on quit', () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-launch-test-')); dirs.push(dir);
      const stopFile = join(dir, 'stop');
      vi.stubEnv('NEKKO_DEV_STOP_FILE', stopFile);
      const quit = vi.fn();
      registerDevLaunch({ quit, on: () => {} });
      vi.advanceTimersByTime(1000);
      expect(quit).not.toHaveBeenCalled();
      writeFileSync(stopFile, 'stop');
      vi.advanceTimersByTime(300);
      expect(quit).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1000);
      expect(quit).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('preserves a replacement receipt during cleanup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-launch-test-')); dirs.push(dir);
    const file = join(dir, 'receipt.json');
    vi.stubEnv('NEKKO_DEV_PID_FILE', file); vi.stubEnv('NEKKO_DEV_LAUNCH_TOKEN', 'first');
    let finish = () => {};
    registerDevLaunch({ quit: vi.fn(), on: (_event, handler) => { finish = handler; } });
    writeFileSync(file, JSON.stringify({ pid: 123, token: 'replacement' }));
    finish(); expect(JSON.parse(readFileSync(file, 'utf8')).token).toBe('replacement');
  });
});
