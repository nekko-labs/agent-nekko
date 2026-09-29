import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTranscriptTokens, type ProviderConfig } from '@agent-nekko/shared';
import type { ChatRequest, Provider } from '@agent-nekko/core';

const providerState = vi.hoisted(() => ({
  mode: 'success',
  started: undefined as (() => void) | undefined,
}));

vi.mock('@agent-nekko/core', async () => {
  const actual = await vi.importActual<typeof import('@agent-nekko/core')>('@agent-nekko/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat(request: ChatRequest) {
        if (providerState.mode === 'cancel') {
          providerState.started?.();
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return;
        }
        yield { type: 'text', delta: 'Summary of decisions and next steps.' };
        yield { type: 'usage', inputTokens: 200, outputTokens: 20 };
        yield { type: 'done' };
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, getSession, saveSession } = await import('./sessions.js');
const { cancelSessionCompaction, compactSession } = await import('./compaction.js');

let dir: string;

const provider: ProviderConfig = {
  id: 'p',
  kind: 'openai-compat',
  label: 'Test provider',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'test',
  enabled: true,
};

function fillSession() {
  const session = createSession();
  session.providerId = provider.id;
  session.modelId = 'test-model';
  session.messages = [
    { id: 'u1', role: 'user', content: `First request: ${'background detail '.repeat(30)}`, createdAt: 1 },
    { id: 'a1', role: 'assistant', content: `First answer: ${'completed analysis '.repeat(30)}`, createdAt: 2 },
    { id: 'u2', role: 'user', content: 'Second request', createdAt: 3 },
    { id: 'a2', role: 'assistant', content: 'Second answer', createdAt: 4 },
    { id: 'u3', role: 'user', content: 'Third request', createdAt: 5 },
    { id: 'a3', role: 'assistant', content: 'Third answer', createdAt: 6 },
  ];
  saveSession(session);
  return session;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-compaction-'));
  setDataDir(dir);
  saveSettings({ providers: [provider], workspaces: [], defaultChatMode: 'yolo' });
  providerState.mode = 'success';
  providerState.started = undefined;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('compactSession', () => {
  it('replaces older turns in the same session and keeps recent turns', async () => {
    const session = fillSession();
    const original = session.messages;

    const compacted = await compactSession(session.id);

    expect(compacted.id).toBe(session.id);
    expect(compacted.messages[0].content).toContain('Conversation summary (compacted)');
    expect(compacted.messages.slice(1)).toEqual(original.slice(2));
    expect(estimateTranscriptTokens(compacted.messages)).toBeLessThan(estimateTranscriptTokens(original));
    expect(getSession(session.id)?.messages).toEqual(compacted.messages);
  });

  it('leaves the stored transcript unchanged when cancelled', async () => {
    const session = fillSession();
    const original = session.messages;
    providerState.mode = 'cancel';
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    providerState.started = signalStarted;

    const operation = compactSession(session.id);
    await started;
    cancelSessionCompaction(session.id);

    await expect(operation).rejects.toThrow();
    expect(getSession(session.id)?.messages).toEqual(original);
  });

  it('does not compact incognito or cloud-backed offline chats', async () => {
    const incognito = fillSession();
    incognito.incognito = true;
    saveSession(incognito);
    await expect(compactSession(incognito.id)).rejects.toThrow(/incognito/i);

    const offline = fillSession();
    offline.offline = true;
    saveSession(offline);
    saveSettings({ providers: [{ ...provider, kind: 'openai', baseUrl: 'https://api.example.test' }] });
    await expect(compactSession(offline.id)).rejects.toThrow(/offline/i);
    expect(getSession(offline.id)?.messages).toEqual(offline.messages);
  });
});
