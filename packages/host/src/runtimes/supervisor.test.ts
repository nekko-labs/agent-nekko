import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { createSupervisor } from './supervisor.js';

/** A child process stand-in we can drive from the test. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => boolean;
    killed: string[];
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (sig = 'SIGTERM') => {
    child.killed.push(sig);
    return true;
  };
  return child;
}

function setup(opts: { healthyAfter?: number } = {}) {
  const child = fakeChild();
  let healthChecks = 0;
  const sup = createSupervisor({
    healthy: async () => {
      healthChecks += 1;
      return opts.healthyAfter !== undefined && healthChecks > opts.healthyAfter;
    },
    spawnFn: (() => child) as never,
  });
  return { sup, child, checks: () => healthChecks };
}

const req = { id: 'p1', baseUrl: 'http://localhost:11434', cmd: 'ollama', args: ['serve'] };

describe('supervisor', () => {
  it('owns a process it started and stops it with its own handle', async () => {
    const { sup, child } = setup({ healthyAfter: 1 });
    const out = await sup.start(req);
    expect(out.ok).toBe(true);
    expect(sup.isOwned('p1')).toBe(true);

    const stopped = await sup.stop('p1', req.baseUrl);
    expect(stopped.ok).toBe(true);
    expect(child.killed).toContain('SIGTERM');
    expect(sup.isOwned('p1')).toBe(false);
  });

  it('refuses to kill a process it did not start, without force', async () => {
    const { sup } = setup();
    const res = await sup.stop('p1', 'http://localhost:11434');
    expect(res.ok).toBe(false);
    expect(res.needsConfirmation).toBe(true);
    expect(res.message).toContain('not started by Agent Nekko');
  });

  it('does not adopt a server that was already running', async () => {
    // healthy from the first check means something else is serving that address.
    const { sup } = setup({ healthyAfter: 0 });
    const out = await sup.start(req);
    expect(out.ok).toBe(true);
    expect(sup.isOwned('p1')).toBe(false);
    expect(out.log.join(' ')).toContain('already running');
  });

  it('surfaces captured stderr when the start fails', async () => {
    const { sup, child } = setup();
    const started = sup.start(req);
    await vi.waitFor(() => expect(child.listenerCount('exit')).toBeGreaterThan(0));
    child.stderr.emit('data', 'Error: listen tcp 127.0.0.1:11434: bind: address already in use\n');
    child.emit('exit', 1);

    const out = await started;
    expect(out.ok).toBe(false);
    expect(out.error).toContain('address already in use');
    expect(sup.isOwned('p1')).toBe(false);
  });

  it('keeps only the tail of a chatty server log', async () => {
    const { sup, child } = setup({ healthyAfter: 1 });
    const started = sup.start(req);
    await vi.waitFor(() => expect(child.stdout.listenerCount('data')).toBeGreaterThan(0));
    for (let i = 0; i < 500; i++) child.stdout.emit('data', `line ${i}\n`);
    const out = await started;
    expect(out.log.length).toBeLessThanOrEqual(200);
    expect(out.log.at(-1)).toBe('line 499');
  });

  it('is idempotent: starting twice does not spawn a second server', async () => {
    const { sup } = setup({ healthyAfter: 1 });
    const first = await sup.start(req);
    const second = await sup.start(req);
    expect(first.ok && second.ok).toBe(true);
    expect(second.startedAt).toBe(first.startedAt);
  });
});
