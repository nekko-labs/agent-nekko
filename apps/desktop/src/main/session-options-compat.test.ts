import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@agent-nekko/shared';
import { IpcChannels } from '@agent-nekko/shared';
import { setSessionOptionsCompat } from './session-options-compat.js';

function session(over: Partial<Session> = {}): Session {
  return {
    id: 's_test',
    title: 'Chat',
    messages: [],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  } as Session;
}

function writeSession(dataDir: string, s: Session): void {
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(join(dataDir, 'sessions', `${s.id}.json`), JSON.stringify(s, null, 2));
}

function readSession(dataDir: string, id = 's_test'): Session {
  return JSON.parse(readFileSync(join(dataDir, 'sessions', `${id}.json`), 'utf8')) as Session;
}

describe('desktop session options compatibility', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('patches archivedAt on disk when an older engine ignores that option', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-archive-compat-'));
    writeSession(dir, session());
    const engineSession = session();
    const engine = { call: vi.fn().mockResolvedValue(engineSession) };

    const saved = await setSessionOptionsCompat(engine, dir, 's_test', { archivedAt: 123 });

    expect(engine.call).toHaveBeenCalledWith(IpcChannels.sessionSetOptions, 's_test', { archivedAt: 123 });
    expect(saved?.archivedAt).toBe(123);
    expect(readSession(dir).archivedAt).toBe(123);
  });

  it('clears archivedAt on disk when an older engine ignores restore', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-archive-compat-'));
    writeSession(dir, session({ archivedAt: 123 }));
    const engine = { call: vi.fn().mockResolvedValue(session({ archivedAt: 123 })) };

    const saved = await setSessionOptionsCompat(engine, dir, 's_test', { archivedAt: null });

    expect(saved?.archivedAt).toBeNull();
    expect(readSession(dir).archivedAt).toBeNull();
  });

  it('leaves non-archive option writes entirely engine-owned', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-archive-compat-'));
    writeSession(dir, session());
    const engineSession = session({ title: 'Renamed' });
    const engine = { call: vi.fn().mockResolvedValue(engineSession) };

    const saved = await setSessionOptionsCompat(engine, dir, 's_test', { title: 'Renamed' });

    expect(saved).toBe(engineSession);
    expect(readSession(dir).title).toBe('Chat');
  });

  it('does not touch disk when a current engine saves completion', async () => {
    const engineSession = session({ archivedAt: 123 });
    const engine = { call: vi.fn().mockResolvedValue(engineSession) };
    expect(await setSessionOptionsCompat(engine, 'unused', 's_test', { archivedAt: 123 })).toBe(engineSession);
  });

  it('rejects unsafe session paths before applying a disk fallback', async () => {
    const engine = { call: vi.fn().mockResolvedValue(session({ id: '../outside' })) };
    await expect(setSessionOptionsCompat(engine, 'unused', '../outside', { archivedAt: 123 }))
      .rejects.toThrow('Invalid session id');
  });

  it('does not fallback when the engine reports the session is missing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nekko-archive-compat-'));
    writeSession(dir, session());
    const engine = { call: vi.fn().mockResolvedValue(null) };

    const saved = await setSessionOptionsCompat(engine, dir, 's_test', { archivedAt: 123 });

    expect(saved).toBeNull();
    expect(readSession(dir).archivedAt).toBeUndefined();
  });
});
