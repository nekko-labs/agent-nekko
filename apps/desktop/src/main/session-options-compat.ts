import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IpcChannels, type Session } from '@nekko-agent/shared';
import type { EngineProcess } from './engine-process.js';

export type SessionOptionsPatch = Partial<Pick<Session, 'archivedAt'>> & Record<string, unknown>;

const pathFor = (dataDir: string, id: string) => join(dataDir, 'sessions', `${id}.json`);

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 20) {
        rmSync(tmp, { force: true });
        throw e;
      }
      const until = Date.now() + 5 * (attempt + 1);
      while (Date.now() < until) { /* keep this sync to match the session write path */ }
    }
  }
}

function sameArchivedAt(actual: unknown, expected: unknown): boolean {
  return actual === expected;
}

function hostPatchArchivedAt(dataDir: string, sessionId: string, archivedAt: number | null): Session | null {
  if (!/^s_[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id.');
  const file = pathFor(dataDir, sessionId);
  if (!existsSync(file)) return null;
  const session = JSON.parse(readFileSync(file, 'utf8')) as Session;
  if (session.id !== sessionId) return null;
  (session as unknown as Record<string, unknown>).archivedAt = archivedAt;
  session.updatedAt = Date.now();
  writeAtomic(file, JSON.stringify(session, null, 2));
  return JSON.parse(readFileSync(file, 'utf8')) as Session;
}

/**
 * Compatibility for older nekkod builds: they accepted `session:setOptions` but
 * silently ignored the newer `archivedAt` option. The renderer only closes a
 * completed chat after the returned session proves it was saved, so patch just
 * this user-owned field on disk when the engine returned the session but did
 * not echo the requested archive state.
 */
export async function setSessionOptionsCompat(engine: Pick<EngineProcess, 'call'>, dataDir: string, sessionId: string, patch: SessionOptionsPatch): Promise<Session | null> {
  const saved = await engine.call<Session | null>(IpcChannels.sessionSetOptions, sessionId, patch);
  if (!Object.prototype.hasOwnProperty.call(patch, 'archivedAt')) return saved;
  const archivedAt = patch.archivedAt;
  if (typeof archivedAt !== 'number' && archivedAt !== null) return saved;
  if (!saved || saved.id !== sessionId || sameArchivedAt(saved.archivedAt, archivedAt)) return saved;
  return hostPatchArchivedAt(dataDir, sessionId, archivedAt);
}
