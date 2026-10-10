import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentEvent, AppSettings, SendOptions, Session } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { createMessagingService, type MessagingHost } from './messaging/service.js';
import type { TelegramApi, TelegramUpdate } from './messaging/telegram.js';

/**
 * A TelegramApi stand-in: records outbound calls and lets the test push
 * inbound updates into the long-poll one at a time. `getUpdates` only resolves
 * when an update is queued, so the poll loop idles instead of spinning.
 */
class FakeTelegram {
  calls: { method: string; args: unknown[] }[] = [];
  private queued: TelegramUpdate[] = [];
  private waiters: ((u: TelegramUpdate[]) => void)[] = [];
  private nextId = 100;

  getMe = async () => ({ id: 7, username: 'nekko_bot' });
  getUpdates = async (): Promise<TelegramUpdate[]> =>
    this.queued.length ? this.queued.splice(0) : new Promise((r) => this.waiters.push(r));
  push = (u: TelegramUpdate) => {
    const w = this.waiters.shift();
    if (w) w([u]);
    else this.queued.push(u);
  };
  sendMessage = async (chatId: number | string, text: string, kb?: unknown) => {
    this.calls.push({ method: 'sendMessage', args: [chatId, text, kb] });
    return { message_id: this.nextId++, chat: { id: Number(chatId), type: 'private' } };
  };
  editMessageText = async (...args: unknown[]) => {
    this.calls.push({ method: 'editMessageText', args });
  };
  answerCallbackQuery = async (...args: unknown[]) => {
    this.calls.push({ method: 'answerCallbackQuery', args });
  };

  find(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
}

class FakeHost implements MessagingHost {
  settings: AppSettings;
  sessions = new Map<string, Session>();
  sent: SendOptions[] = [];
  approved: { sessionId: string; callId: string; approved: boolean }[] = [];
  answered: { sessionId: string; callId: string; answers: unknown[] }[] = [];
  emitter = new EventEmitter();
  private seq = 0;

  constructor() {
    this.settings = {
      theme: 'dark',
      accent: '',
      sandboxMode: 'off',
      providers: [{ id: 'p1', kind: 'openai-compat', label: 'Mock', baseUrl: 'http://x', enabled: true }],
      guardrails: [],
      workspaces: [],
      connectors: [],
      defaultProviderId: 'p1',
      defaultModelId: 'm1',
      mascotEnabled: false,
      messaging: { telegram: { enabled: true, botToken: 'tok', allowedChatIds: ['42'] } },
    } as AppSettings;
  }

  getSettings() {
    return this.settings;
  }
  getSession(id: string) {
    return this.sessions.get(id) ?? null;
  }
  createSession() {
    const s: Session = { id: `s${++this.seq}`, title: 'New chat', messages: [], createdAt: 1, updatedAt: 1 };
    this.sessions.set(s.id, s);
    return s;
  }
  async listModels() {
    return [{ id: 'm1', providerId: 'p1' }];
  }
  async sendChat(o: SendOptions) {
    this.sent.push(o);
  }
  approveTool(sessionId: string, callId: string, approved: boolean) {
    this.approved.push({ sessionId, callId, approved });
  }
  answerQuestion(sessionId: string, callId: string, answers: { questionId: string; labels: string[]; note?: string }[]) {
    this.answered.push({ sessionId, callId, answers });
  }
  events = this.emitter as unknown as MessagingHost['events'];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inbound = (chatId: number, text: string, id = Date.now()): TelegramUpdate => ({
  update_id: id,
  message: { message_id: 1, chat: { id: chatId, type: 'private' }, text },
});

let dir: string;
let tg: FakeTelegram;
let host: FakeHost;
let service: ReturnType<typeof createMessagingService>;

beforeEach(async () => {
  vi.useRealTimers();
  dir = mkdtempSync(join(tmpdir(), 'nekko-msg-'));
  setDataDir(dir);
  tg = new FakeTelegram();
  host = new FakeHost();
  service = createMessagingService(host, () => tg as unknown as TelegramApi);
  service.update(host.settings.messaging);
  // getMe + poll bootstrap
  await sleep(10);
});

afterEach(() => {
  service.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('messaging bridge', () => {
  it('stays off without a token or while disabled', () => {
    const off = createMessagingService(host, () => tg as unknown as TelegramApi);
    off.update(undefined);
    expect(off.status().telegram).toBeUndefined();
    off.update({ telegram: { enabled: false, botToken: 'tok' } });
    expect(off.status().telegram).toBeUndefined();
  });

  it('starts polling when enabled and reports the bot', async () => {
    await vi.waitFor(() => expect(service.status().telegram?.running).toBe(true));
    expect(service.status().telegram?.botUsername).toBe('nekko_bot');
  });

  it('refuses chats not on the allowlist, and never creates a session', async () => {
    tg.push(inbound(99, 'hello'));
    await vi.waitFor(() => expect(tg.find('sendMessage').length).toBe(1));
    expect(String(tg.find('sendMessage')[0].args[1])).toMatch(/not on the allowlist/);
    expect(host.sessions.size).toBe(0);
    expect(host.sent).toHaveLength(0);
  });

  it('binds an allowed chat to a session and drives a reply', async () => {
    tg.push(inbound(42, 'fix the tests'));
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.sent[0]).toMatchObject({ providerId: 'p1', modelId: 'm1', text: 'fix the tests' });
    const sessionId = host.sent[0].sessionId;

    // A second message continues the same session rather than a new one.
    tg.push(inbound(42, 'and lint too'));
    await vi.waitFor(() => expect(host.sent).toHaveLength(2));
    expect(host.sent[1].sessionId).toBe(sessionId);
    expect(service.status().telegram?.boundChats).toBe(1);
  });

  it('streams the reply into one edited message', async () => {
    tg.push(inbound(42, 'hi'));
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    const sessionId = host.sent[0].sessionId;

    host.emitter.emit('agentEvent', { type: 'text', sessionId, delta: 'Hello ' } satisfies AgentEvent);
    host.emitter.emit('agentEvent', { type: 'text', sessionId, delta: 'there' } satisfies AgentEvent);
    await sleep(1600);
    // First flush sends; later deltas edit that same message.
    host.emitter.emit('agentEvent', { type: 'text', sessionId, delta: '!' } satisfies AgentEvent);
    await sleep(1600);
    host.emitter.emit('agentEvent', { type: 'done', sessionId, messageId: 'm' } satisfies AgentEvent);
    await sleep(50);

    const sends = tg.find('sendMessage').filter((c) => String(c.args[0]) === '42');
    const edits = tg.find('editMessageText');
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(String(edits.at(-1)!.args[2])).toBe('Hello there!');
  });

  it('turns approvals into buttons and the button press into a decision', async () => {
    tg.push(inbound(42, 'run it'));
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    const sessionId = host.sent[0].sessionId;

    host.emitter.emit('agentEvent', {
      type: 'tool_approval_required',
      sessionId,
      call: { id: 'call-9', name: 'write_file' },
      reason: 'writes src/x.ts',
      severity: 'medium',
    } satisfies AgentEvent);
    await vi.waitFor(() => {
      const kb = tg.find('sendMessage').find((c) => c.args[2])?.args[2] as { text: string; callback_data: string }[][] | undefined;
      expect(kb?.[0]?.map((b) => b.text)).toEqual(['Approve', 'Deny']);
    });
    const kb = tg.find('sendMessage').find((c) => c.args[2])!.args[2] as { callback_data: string }[][];
    tg.push({ update_id: Date.now(), callback_query: { id: 'q1', from: { id: 5 }, message: { message_id: 55, chat: { id: 42, type: 'private' } }, data: kb[0][0].callback_data } });
    await vi.waitFor(() => expect(host.approved).toHaveLength(1));
    expect(host.approved[0]).toMatchObject({ sessionId, callId: 'call-9', approved: true });
    expect(tg.find('answerCallbackQuery').length).toBe(1);
  });

  it('routes ask_user questions to buttons and typed replies to answers', async () => {
    tg.push(inbound(42, 'start'));
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    const sessionId = host.sent[0].sessionId;

    host.emitter.emit('agentEvent', {
      type: 'question',
      sessionId,
      request: {
        callId: 'ask-1',
        askedAt: 1,
        questions: [{ id: 'q1', header: 'Pick', question: 'Which auth?', options: [{ label: 'JWT' }, { label: 'OAuth' }] }],
      },
    } satisfies AgentEvent);
    await vi.waitFor(() => {
      const kb = tg.find('sendMessage').find((c) => c.args[2])?.args[2] as { text: string }[][] | undefined;
      expect(kb?.flat().map((b) => b.text)).toEqual(['JWT', 'OAuth']);
    });
    const kb = tg.find('sendMessage').find((c) => c.args[2])!.args[2] as { callback_data: string }[][];
    tg.push({ update_id: Date.now(), callback_query: { id: 'q2', from: { id: 5 }, message: { message_id: 77, chat: { id: 42, type: 'private' } }, data: kb[0][0].callback_data } });
    await vi.waitFor(() => expect(host.answered).toHaveLength(1));
    expect(host.answered[0].callId).toBe('ask-1');
    expect((host.answered[0].answers as { labels: string[] }[])[0].labels).toEqual(['JWT']);
  });

  it('treats expired callbacks as expired rather than acting', async () => {
    tg.push({ update_id: Date.now(), callback_query: { id: 'q9', from: { id: 5 }, message: { message_id: 1, chat: { id: 42, type: 'private' } }, data: 'm:999' } });
    await vi.waitFor(() => expect(tg.find('answerCallbackQuery').length).toBe(1));
    expect(String(tg.find('answerCallbackQuery')[0].args[1])).toMatch(/expired/);
    expect(host.approved).toHaveLength(0);
  });
});
