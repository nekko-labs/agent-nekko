import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';
import { loopEnd, runAgentViaDaemon } from './daemon-loop.js';

const opts = {
  sessionId: 's',
  provider: { id: 'p', kind: 'anthropic' as const, label: 'p', baseUrl: 'x', enabled: true },
  model: 'm',
  system: '',
  history: [],
  tools: [],
  executeTool: async () => ({ toolCallId: '', output: '' }),
  livenessIntervalMs: 10,
};

describe('runAgentViaDaemon liveness', () => {
  it('ends a run as interrupted when the daemon no longer knows it', async () => {
    const call = vi.fn(async (channel: string) => {
      if (channel === 'loop:run') return { started: true } as never;
      if (channel === 'daemon:info') return { owned: ['loop:run', 'loop:unbounded', 'loop:alive'] } as never;
      if (channel === 'loop:alive') return false as never;
      return true as never;
    });
    const events: AgentEvent[] = [];
    for await (const e of runAgentViaDaemon(call, { ...opts, history: [] })) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', sessionId: 's' });
    expect((events[0] as { message: string }).message).toMatch(/engine stopped/);
    expect(call.mock.calls.some(([c]) => c === 'loop:alive')).toBe(true);
  });

  it('leaves a silent run alone while the daemon still has it, and when the daemon is too old to ask', async () => {
    for (const owned of [['loop:run', 'loop:unbounded', 'loop:alive'], ['loop:run', 'loop:unbounded']]) {
      // `daemonOwns` caches the answer for the process, so the module is reloaded per case.
      vi.resetModules();
      const mod = await import('./daemon-loop.js');
      let probes = 0;
      const call = vi.fn(async (channel: string, ...args: unknown[]) => {
        if (channel === 'daemon:info') return { owned } as never;
        if (channel === 'loop:alive') {
          probes++;
          return true as never;
        }
        if (channel === 'loop:run') {
          const { runId } = args[0] as { runId: string };
          setTimeout(() => mod.loopEnd(runId, { history: [] }), 60);
          return { started: true } as never;
        }
        return true as never;
      });
      const events: AgentEvent[] = [];
      for await (const e of mod.runAgentViaDaemon(call, { ...opts, history: [] })) events.push(e);
      expect(events).toEqual([]);
      if (owned.includes('loop:alive')) expect(probes).toBeGreaterThan(0);
      else expect(probes).toBe(0);
    }
  });

  it('ends the run here when the daemon cannot be reached', async () => {
    vi.resetModules();
    const mod = await import('./daemon-loop.js');
    const call = vi.fn(async (channel: string) => {
      if (channel === 'loop:run') return { started: true } as never;
      if (channel === 'daemon:info') return { owned: ['loop:run', 'loop:unbounded', 'loop:alive'] } as never;
      throw new Error('ECONNREFUSED');
    });
    const events: AgentEvent[] = [];
    for await (const e of mod.runAgentViaDaemon(call, { ...opts, history: [] })) events.push(e);
    expect(events).toHaveLength(1);
    expect((events[0] as { message: string }).message).toMatch(/could not be reached/);
  });

  it('ends the run here when Stop cannot reach the daemon', async () => {
    vi.resetModules();
    const mod = await import('./daemon-loop.js');
    const abort = new AbortController();
    const call = vi.fn(async (channel: string) => {
      if (channel === 'loop:run') return { started: true } as never;
      if (channel === 'daemon:info') return { owned: ['loop:run', 'loop:unbounded'] } as never;
      throw new Error('ECONNREFUSED');
    });
    const events: AgentEvent[] = [];
    setTimeout(() => abort.abort(), 15);
    for await (const e of mod.runAgentViaDaemon(call, { ...opts, history: [], signal: abort.signal, livenessIntervalMs: 1000 })) events.push(e);
    expect(events).toEqual([expect.objectContaining({ type: 'error', message: 'Stopped' })]);
    expect(loopEnd).toBeDefined();
  });
});
