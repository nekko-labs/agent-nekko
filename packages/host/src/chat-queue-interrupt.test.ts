import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '@agent-nekko/shared';
import type { Provider } from '@agent-nekko/core';

let started: (() => void) | undefined;
let calls = 0;
vi.mock('@agent-nekko/core', async () => {
  const actual = await vi.importActual<typeof import('@agent-nekko/core')>('@agent-nekko/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(request) {
        const signal = request.signal;
        calls++;
        started?.();
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        yield { type: 'text' as const, delta: 'reply' };
        yield { type: 'done' as const };
      },
    }),
  };
});

const { createHost } = await import('./host.js');
const { getSession } = await import('./sessions.js');
const { IpcChannels } = await import('@agent-nekko/shared');
const { createDispatcher } = await import('./dispatch.js');

beforeEach(() => { calls = 0; started = undefined; process.env.NEKKO_AGENT_LOOP = 'ts'; });

describe('interrupt queued prompt', () => {
  it('rejects invalid indices without stopping the active turn', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    const s = host.createSession();
    host.queuePrompt(s.id, 'one');
    await expect(host.interruptQueuedPrompt(s.id, -1)).rejects.toThrow('Queued prompt not found');
    await expect(host.interruptQueuedPrompt(s.id, 1)).rejects.toThrow('Queued prompt not found');
    expect(getSession(s.id)?.queue).toEqual(['one']);
  });

  it('keeps a selected prompt queued when the provider cannot start', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'missing', modelId: 'm' });
    host.queuePrompt(s.id, 'one');
    await host.interruptQueuedPrompt(s.id, 0);
    expect(getSession(s.id)?.queue).toEqual(['one']);
    expect(getSession(s.id)?.messages).toEqual([]);
  });

  it('stops the old turn then starts only the selected item, retaining the others', async () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-queue-')) });
    host.saveProvider({ id: 'p', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true });
    const s = host.createSession();
    host.setSessionOptions(s.id, { providerId: 'p', modelId: 'm' });
    let ready!: () => void;
    const entered = new Promise<void>((resolve) => { ready = resolve; });
    started = ready;
    const old = host.sendChat({ sessionId: s.id, providerId: 'p', modelId: 'm', text: 'old' });
    await entered;
    host.queuePrompt(s.id, 'first');
    host.queuePrompt(s.id, 'selected');
    host.queuePrompt(s.id, 'last');
    await createDispatcher(host)(IpcChannels.chatInterruptQueued, [s.id, 1]);
    await old;
    expect(getSession(s.id)?.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['old', 'selected', 'first', 'last']);
    expect(getSession(s.id)?.queue).toEqual([]);
  });
});
