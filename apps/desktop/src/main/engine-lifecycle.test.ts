import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }));
import { EngineProcess } from './engine-process.js';

function child() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), exitCode: null });
}
const options = { dataDir: '/data', app: { isPackaged: false, appPath: '/missing', userData: '/u', version: '0' }, origins: ['null'], mainDir: '/main' };
afterEach(() => { vi.useRealTimers(); mocked.spawn.mockReset(); });

describe('service lifecycle', () => {
  it('starts once, rejects waiters on stop and supports a fresh start', async () => {
    const first = child(); const second = child();
    mocked.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const engine = new EngineProcess(options);
    engine.start(); engine.start();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    const waiting = expect(engine.endpoint()).rejects.toThrow('stopped');
    const stopped = engine.stop();
    first.emit('exit', 0, null);
    await stopped; await waiting;
    await expect(engine.endpoint()).rejects.toThrow('stopped');
    engine.start();
    second.stdout.write('NEKKO_BACKEND_READY {"port":12345}\n');
    expect((await engine.endpoint()).url).toBe('http://127.0.0.1:12345');
    const final = engine.stop(); second.emit('exit', 0, null); await final;
  });
  it('manual stop cancels an already scheduled crash restart', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start(); first.emit('exit', 1, null);
    await engine.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    expect(engine.running).toBe(false);
  });
  it('bounds startup waits and cannot restart while shutdown is incomplete', async () => {
    vi.useFakeTimers();
    const first = child(); mocked.spawn.mockReturnValue(first);
    const engine = new EngineProcess(options);
    engine.start();
    const ready = expect(engine.endpoint()).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(15000); await ready;
    const stopping = engine.stop(); engine.start();
    expect(mocked.spawn).toHaveBeenCalledTimes(1);
    first.emit('exit', 0, null); await stopping;
  });
});
