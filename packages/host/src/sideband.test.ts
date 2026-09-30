import { beforeEach, describe, expect, it, vi } from 'vitest';

const daemon = vi.fn();
let linked = true;
vi.mock('./engine/daemon.js', () => ({ daemonCall: () => (linked ? daemon : undefined) }));
const chat = vi.fn();
vi.mock('@agent-nekko/core', () => ({ createProvider: () => ({ chat }) }));

const { completeText } = await import('./sideband.js');

const provider = { id: 'p', kind: 'llamacpp', label: 'P', baseUrl: 'http://x', enabled: true } as never;
const request = { model: 'm', messages: [], purpose: 'title' as const };

describe('completeText', () => {
  beforeEach(() => {
    daemon.mockReset();
    chat.mockReset();
    linked = true;
    delete process.env.NEKKO_AGENT_LOOP;
  });

  it('asks the daemon when it serves provider:complete', async () => {
    daemon.mockImplementation(async (channel: string) =>
      channel === 'daemon:info' ? { owned: ['provider:complete'] } : { text: 'Fix the parser' },
    );
    expect(await completeText(provider, request, 5_000)).toBe('Fix the parser');
    expect(daemon).toHaveBeenLastCalledWith('provider:complete', { provider, request, timeoutMs: 5_000 });
    expect(chat).not.toHaveBeenCalled();
  });

  it('runs here without a daemon, or with the kill switch on', async () => {
    chat.mockImplementation(async function* () {
      yield { type: 'reasoning', delta: 'hmm' };
      yield { type: 'text', delta: 'Fix ' };
      yield { type: 'text', delta: 'it' };
    });
    linked = false;
    expect(await completeText(provider, request)).toBe('Fix it');
    linked = true;
    process.env.NEKKO_AGENT_LOOP = 'ts';
    expect(await completeText(provider, request)).toBe('Fix it');
    expect(daemon).not.toHaveBeenCalled();
    expect(chat.mock.calls[0][0]).toMatchObject({ model: 'm', purpose: 'title', signal: expect.any(AbortSignal) });
  });
});
