import { describe, expect, it } from 'vitest';
import { IpcChannels, IpcEvents } from '../../../../packages/shared/src/ipc';
import { Channels, Events, publicProviders, visibleSummaries } from './protocol';

describe('protocol mirror', () => {
  it('uses the host channel names', () => {
    for (const [k, v] of Object.entries(Channels)) {
      expect(IpcChannels[k as keyof typeof IpcChannels], k).toBe(v);
    }
    expect(IpcEvents.agentEvent).toBe(Events.agentEvent);
  });

  it('strips provider secrets on arrival', () => {
    const list = publicProviders([
      { id: 'a', kind: 'anthropic', label: 'Anthropic', baseUrl: 'x', apiKey: 'sk-secret', enabled: true },
      null,
      { nope: 1 },
    ]);
    expect(list).toEqual([{ id: 'a', kind: 'anthropic', label: 'Anthropic', enabled: true }]);
    expect(JSON.stringify(list)).not.toContain('sk-secret');
  });

  it('lists only top-level, live chats, newest first', () => {
    const base = { messageCount: 1, exchangeCount: 1, transcriptTokens: 0, stalled: false, recentTurns: [], prUrls: [], imageCount: 0, createdAt: 0 };
    const out = visibleSummaries([
      { ...base, id: 'old', title: 'old', updatedAt: 1 },
      { ...base, id: 'new', title: 'new', updatedAt: 3 },
      { ...base, id: 'arch', title: 'a', updatedAt: 9, archivedAt: 5 },
      { ...base, id: 'sub', title: 's', updatedAt: 9, parentSessionId: 'new' },
      { ...base, id: 'task', title: 't', updatedAt: 9, taskId: 't1' },
    ] as never);
    expect(out.map((s) => s.id)).toEqual(['new', 'old']);
  });
});
