import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import type { Session } from '@agent-nekko/shared';
import { dataDir } from './store.js';

function sessionsDir(): string {
  const dir = join(dataDir(), 'sessions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const pathFor = (id: string) => join(sessionsDir(), `${id}.json`);

export function listSessions(): Session[] {
  return readdirSync(sessionsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(sessionsDir(), f), 'utf8')) as Session;
      } catch {
        return null;
      }
    })
    .filter((s): s is Session => !!s)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): Session | null {
  if (!existsSync(pathFor(id))) return null;
  try {
    return JSON.parse(readFileSync(pathFor(id), 'utf8')) as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  s.updatedAt = Date.now();
  writeFileSync(pathFor(s.id), JSON.stringify(s, null, 2), 'utf8');
}

export function deleteSession(id: string): void {
  if (existsSync(pathFor(id))) rmSync(pathFor(id));
}

export function setSessionWorkspace(id: string, workspaceId?: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.workspaceId = workspaceId;
  if (s.supportingWorkspaceIds?.length) {
    s.supportingWorkspaceIds = s.supportingWorkspaceIds.filter((wid) => wid !== workspaceId);
    if (s.supportingWorkspaceIds.length === 0) s.supportingWorkspaceIds = undefined;
  }
  saveSession(s);
  return s;
}

export function setSessionSupportingWorkspaces(id: string, workspaceIds: string[]): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const next = Array.from(new Set(workspaceIds.filter((wid) => wid && wid !== s.workspaceId)));
  s.supportingWorkspaceIds = next.length ? next : undefined;
  saveSession(s);
  return s;
}

export function setSessionAttachments(id: string, paths: string[]): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.attachedPaths = paths;
  saveSession(s);
  return s;
}

export function setSpecLinked(id: string, linked: boolean): Session | null {
  const s = getSession(id);
  if (!s) return null;
  s.specLinked = linked;
  saveSession(s);
  return s;
}

/** Drop a message and everything after it (used by edit-and-resend). */
export function truncateSession(id: string, messageId: string): Session | null {
  const s = getSession(id);
  if (!s) return null;
  const idx = s.messages.findIndex((m) => m.id === messageId);
  if (idx >= 0) s.messages = s.messages.slice(0, idx);
  saveSession(s);
  return s;
}

/** Delete chats within a time window (today / this month / all). Returns count. */
export function clearSessions(scope: 'today' | 'month' | 'all'): number {
  let cutoff = 0;
  if (scope !== 'all') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    if (scope === 'month') d.setDate(1);
    cutoff = d.getTime();
  }
  let n = 0;
  for (const s of listSessions()) {
    if (scope === 'all' || s.updatedAt >= cutoff) {
      deleteSession(s.id);
      n++;
    }
  }
  return n;
}

/** Patch per-chat options (title, pin, mode, disabled tools, offline, incognito, brain). */
export function setSessionOptions(
  id: string,
  patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'order' | 'mode' | 'disabledTools' | 'offline' | 'incognito' | 'autoModel' | 'autoQuality' | 'thinking' | 'providerId' | 'modelId'>>,
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  Object.assign(s, patch);
  saveSession(s);
  return s;
}

/** Append a prompt to a chat's run-queue (executed when the current turn ends). */
export function queuePrompt(id: string, text: string): Session | null {
  const s = getSession(id);
  if (!s || !text.trim()) return s;
  s.queue = [...(s.queue ?? []), text.trim()];
  saveSession(s);
  return s;
}

/** Remove a queued prompt by index. */
export function dequeuePrompt(id: string, index: number): Session | null {
  const s = getSession(id);
  if (!s?.queue) return s ?? null;
  s.queue = s.queue.filter((_, i) => i !== index);
  saveSession(s);
  return s;
}

export function createSession(workspaceId?: string, parentSessionId?: string, supportingWorkspaceIds?: string[]): Session {
  const now = Date.now();
  const s: Session = {
    // Crypto-random suffix, not Math.random: a session id names a file in the
    // data dir and is passed around as a handle, and the remote transport lets
    // one reach the network, so it should not be guessable from a timestamp.
    // Same readable `s_<time>_<rand>` shape as before; ids are never parsed.
    id: `s_${now.toString(36)}_${randomBytes(6).toString('base64url')}`,
    title: parentSessionId ? 'Sub-agent' : 'New chat',
    workspaceId,
    supportingWorkspaceIds: supportingWorkspaceIds?.length ? supportingWorkspaceIds : undefined,
    parentSessionId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  saveSession(s);
  return s;
}
