import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '@agent-nekko/shared';
import { summarizeSession } from '@agent-nekko/shared';
import { setDataDir } from './paths.js';
import { createSession, deleteSession, getSession, listSessionSummaries, saveSession } from './sessions.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-sessions-'));
  setDataDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const withTranscript = (s: Session): Session => ({
  ...s,
  title: 'Refactor the parser',
  messages: [
    { id: 'u1', role: 'user', content: 'Review the parser and open a PR', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', input: {} }], createdAt: 2 },
    { id: 't1', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: 'https://github.com/o/r/pull/7' }, createdAt: 3 },
    { id: 'a2', role: 'assistant', content: 'Opened   the PR.\nAll green.', createdAt: 4 },
  ],
});

describe('listSessionSummaries', () => {
  it('lists every chat without its transcript, with what lists read off it', async () => {
    const s = withTranscript(createSession());
    saveSession(s);
    const [summary] = await listSessionSummaries();
    expect(summary).not.toHaveProperty('messages');
    expect(summary).toMatchObject({
      id: s.id,
      title: 'Refactor the parser',
      messageCount: 4,
      exchangeCount: 3,
      firstUserText: 'Review the parser and open a PR',
      lastReplyText: 'Opened the PR. All green.',
      lastReplyAt: 4,
      stalled: false,
      prUrls: ['https://github.com/o/r/pull/7'],
    });
    expect(summary.recentTurns.map((t) => t.id)).toEqual(['u1', 'a2']);
    expect(summary).toEqual(summarizeSession(getSession(s.id)!));
  });

  it('sorts newest first and drops deleted chats', async () => {
    const a = createSession();
    const b = createSession();
    b.updatedAt = a.updatedAt + 1_000;
    writeFileSync(join(dir, 'sessions', `${b.id}.json`), JSON.stringify(b));
    expect((await listSessionSummaries()).map((s) => s.id)).toEqual([b.id, a.id]);
    deleteSession(b.id);
    expect((await listSessionSummaries()).map((s) => s.id)).toEqual([a.id]);
  });

  it('re-reads a chat another process rewrote, and serves the rest from cache', async () => {
    const s = createSession();
    await listSessionSummaries();
    const file = join(dir, 'sessions', `${s.id}.json`);
    writeFileSync(file, JSON.stringify({ ...withTranscript(s), title: 'Changed elsewhere' }));
    // Same second as the first write on coarse filesystems: move the mtime on.
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
    const [summary] = await listSessionSummaries();
    expect(summary.title).toBe('Changed elsewhere');
    expect(summary.messageCount).toBe(4);
  });

  it('skips a file that is not a session', async () => {
    createSession();
    writeFileSync(join(dir, 'sessions', 'broken.json'), '{ not json');
    expect(await listSessionSummaries()).toHaveLength(1);
  });
});
