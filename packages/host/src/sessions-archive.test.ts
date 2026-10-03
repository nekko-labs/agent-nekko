import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setDataDir } from './paths.js';
import { createSession, forkSession, getSession, purgeExpiredArchives, saveSession, saveTurnSession, setSessionOptions } from './sessions.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-archive-'));
  setDataDir(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const DAY = 86_400_000;

describe('archiving', () => {
  it('sets and clears archivedAt through the options patch', () => {
    const s = createSession();
    expect(setSessionOptions(s.id, { archivedAt: 123 })?.archivedAt).toBe(123);
    expect(setSessionOptions(s.id, { archivedAt: null })?.archivedAt).toBeNull();
  });

  it('keeps an archive that a running turn did not know about', () => {
    const s = createSession();
    const inMemory = getSession(s.id)!;
    setSessionOptions(s.id, { archivedAt: 500 });
    saveTurnSession(inMemory);
    expect(getSession(s.id)?.archivedAt).toBe(500);
  });

  it('deletes only archives past the 60-day window', () => {
    const now = Date.now();
    const old = createSession();
    const recent = createSession();
    const live = createSession();
    setSessionOptions(old.id, { archivedAt: now - 61 * DAY });
    setSessionOptions(recent.id, { archivedAt: now - 59 * DAY });
    expect(purgeExpiredArchives(now)).toBe(1);
    expect(getSession(old.id)).toBeNull();
    expect(getSession(recent.id)).not.toBeNull();
    expect(getSession(live.id)).not.toBeNull();
  });
});

describe('forkSession', () => {
  const seed = (workspaceId?: string) => {
    const s = createSession(workspaceId);
    s.modelId = 'm1';
    s.messages = [
      { id: 'u1', role: 'user', content: 'first', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'reply', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'second', images: ['data:image/png;base64,AAA'], createdAt: 3 },
    ];
    saveSession(s);
    return s;
  };

  it('copies the conversation before a message into a new chat and leaves the source alone', () => {
    const src = seed('w1');
    const fork = forkSession(src.id, 'u2')!;
    expect(fork.id).not.toBe(src.id);
    expect(fork.workspaceId).toBe('w1');
    expect(fork.modelId).toBe('m1');
    expect(fork.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(getSession(src.id)?.messages).toHaveLength(3);
    expect(getSession(fork.id)?.messages).toHaveLength(2);
  });

  it('copies everything when the message is unknown, and is null for an unknown chat', () => {
    const src = seed();
    expect(forkSession(src.id, 'nope')?.messages).toHaveLength(3);
    expect(forkSession('s_missing')).toBeNull();
  });
});
