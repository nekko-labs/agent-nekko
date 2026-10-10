import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTranscriptTokens, type AgentEvent, type CompactionProgress, type ProviderConfig } from '@agent-nekko/shared';
import type { ChatRequest, Provider } from '@agent-nekko/core';

const providerState = vi.hoisted(() => ({
  mode: 'success',
  started: undefined as (() => void) | undefined,
  release: undefined as (() => void) | undefined,
  requests: [] as string[],
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
        providerState.requests.push(request.messages.map((m) => m.content).join(' '));
        if (providerState.mode === 'hold') {
          providerState.started?.();
          await new Promise<void>((resolve) => { providerState.release = resolve; });
        }
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
const { cancelSessionCompaction, compactSession, setCompactionSender } = await import('./compaction.js');
const { fromLatestCompaction } = await import('@agent-nekko/core');

let progress: CompactionProgress[] = [];
setCompactionSender((e: AgentEvent) => { if (e.type === 'compaction') progress.push(e.progress); });

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
  providerState.release = undefined;
  providerState.requests = [];
  progress = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('compactSession', () => {
  it('keeps the older turns, adds a summary after them, and keeps recent turns', async () => {
    const session = fillSession();
    const original = session.messages;

    const compacted = await compactSession(session.id);

    expect(compacted.id).toBe(session.id);
    // Nothing is deleted: the summary goes in after the two turns it replaces.
    expect(compacted.messages.slice(0, 2)).toEqual(original.slice(0, 2));
    expect(compacted.messages[2]).toMatchObject({ role: 'assistant', compaction: { summarized: 2 }, content: 'Summary of decisions and next steps.' });
    expect(compacted.messages.slice(3)).toEqual(original.slice(2));
    expect(estimateTranscriptTokens(compacted.messages)).toBeLessThan(estimateTranscriptTokens(original));
    expect(getSession(session.id)?.messages).toEqual(compacted.messages);
  });

  it('sends a model only the summary and what follows it', async () => {
    const compacted = await compactSession(fillSession().id);
    const sent = fromLatestCompaction(compacted.messages);
    expect(sent.map((m) => m.id)).toEqual(['u2', 'a2', 'u3', 'a3']);
    expect(sent[0].content).toMatch(/^Summary of the earlier conversation[\s\S]*Summary of decisions[\s\S]*Second request$/);
    expect(sent.some((m) => m.content.includes('First request'))).toBe(false);
  });

  it('reports progress from start to done', async () => {
    // An omitted options argument can cross IPC as null.
    await compactSession(fillSession().id, null);
    expect(progress[0]).toMatchObject({ state: 'running', done: 0, target: 'here' });
    expect(progress.at(-1)).toMatchObject({ state: 'done', done: 1, total: 1 });
  });

  it('can send the summary to a new chat and leave this one as it was', async () => {
    const session = fillSession();
    const original = session.messages;

    const landed = await compactSession(session.id, { newChat: true });

    expect(landed.id).not.toBe(session.id);
    expect(landed.title).toBe(`${session.title} (continued)`);
    expect(landed.workspaceId).toBe(session.workspaceId);
    expect(landed.providerId).toBe(session.providerId);
    expect(landed.messages[0]).toMatchObject({ compaction: { summarized: 2 } });
    expect(landed.messages.slice(1)).toEqual(original.slice(2));
    expect(getSession(session.id)?.messages).toEqual(original);
    expect(progress.at(-1)).toMatchObject({ state: 'done', target: 'new', newSessionId: landed.id });
  });

  it('redirects a running compaction to a new chat', async () => {
    const session = fillSession();
    const original = session.messages;
    providerState.mode = 'hold';
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    providerState.started = signalStarted;

    const first = compactSession(session.id);
    await started;
    const redirected = compactSession(session.id, { newChat: true });
    providerState.release!();

    const [a, b] = await Promise.all([first, redirected]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(session.id);
    expect(getSession(session.id)?.messages).toEqual(original);
  });

  it('clips long tool output before summarizing it', async () => {
    const session = fillSession();
    session.messages.splice(1, 0,
      { id: 'a0', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'cat big.log' } }], createdAt: 1 },
      { id: 't0', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: `START${'x'.repeat(50_000)}END` }, createdAt: 1 },
    );
    saveSession(session);

    await compactSession(session.id);

    const sent = providerState.requests.join(' ');
    expect(sent).toContain('START');
    expect(sent).toContain('END');
    expect(sent).toContain('characters left out');
    expect(sent.length).toBeLessThan(10_000);
  });

  it('summarizes only what came after the previous summary', async () => {
    const session = fillSession();
    await compactSession(session.id);
    const again = getSession(session.id)!;
    again.messages.push(
      { id: 'u4', role: 'user', content: 'Fourth request', createdAt: 7 },
      { id: 'a4', role: 'assistant', content: 'Fourth answer', createdAt: 8 },
    );
    saveSession(again);
    providerState.requests = [];

    const twice = await compactSession(session.id);

    const sent = providerState.requests.join(' ');
    expect(sent).toContain('SUMMARY OF EVEN EARLIER CONVERSATION');
    expect(sent).not.toContain('First request');
    expect(twice.messages.filter((m) => m.compaction)).toHaveLength(2);
    expect(fromLatestCompaction(twice.messages).map((m) => m.id)).toEqual(['u3', 'a3', 'u4', 'a4']);
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
    expect(progress.at(-1)).toMatchObject({ state: 'cancelled' });
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
