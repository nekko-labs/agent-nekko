import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';
import type { Session, SessionSummary } from '@agent-nekko/shared';
import { summarizeSession } from '@agent-nekko/shared';
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

/**
 * Summaries by file path, valid while the file's mtime and size still match.
 *
 * Keyed by the full path rather than the id so data dirs never share entries
 * (the cloud edition serves several). Writes through this module refresh their
 * entry directly; anything else that touches a file (another process on the
 * same data dir) shows up as a changed mtime and is re-read.
 */
const summaryCache = new Map<string, { mtimeMs: number; size: number; summary: SessionSummary }>();

function remember(file: string, session: Session): void {
  try {
    const st = statSync(file);
    summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary: summarizeSession(session) });
  } catch {
    summaryCache.delete(file);
  }
}

/**
 * Every chat without its transcript, newest first.
 *
 * Asynchronous on purpose: this runs on every sidebar refresh, and in the
 * desktop app the host shares a thread with the window's IPC. Only files that
 * changed since the last call are read and parsed; the rest come from the cache.
 */
export async function listSessionSummaries(): Promise<SessionSummary[]> {
  const dir = sessionsDir();
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const live = new Set<string>();
  const out = await Promise.all(
    names.map(async (name): Promise<SessionSummary | null> => {
      const file = join(dir, name);
      live.add(file);
      try {
        const st = await stat(file);
        const hit = summaryCache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
        const summary = summarizeSession(JSON.parse(await readFile(file, 'utf8')) as Session);
        summaryCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, summary });
        return summary;
      } catch {
        return null;
      }
    }),
  );
  for (const file of summaryCache.keys()) if (file.startsWith(dir) && !live.has(file)) summaryCache.delete(file);
  return out.filter((s): s is SessionSummary => !!s).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(id: string): Session | null {
  if (!existsSync(pathFor(id))) return null;
  try {
    return JSON.parse(readFileSync(pathFor(id), 'utf8')) as Session;
  } catch {
    return null;
  }
}

/**
 * Write a chat whole or not at all: to a temp file beside it, then renamed
 * over it. The engine daemon reads these files concurrently (it serves the
 * session lists and opens), and an in-place write could hand it half a file.
 */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      // Windows refuses a rename over a file another process has open without
      // delete sharing (an antivirus scan, an editor); that clears in moments.
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 20) {
        rmSync(tmp, { force: true });
        throw e;
      }
      const until = Date.now() + 5 * (attempt + 1);
      while (Date.now() < until) { /* a few ms, synchronously: saveSession is sync */ }
    }
  }
}

/**
 * What the user owns on a chat, as opposed to what a running turn owns (the
 * transcript, the model it ran on, the plan it keeps, an automatic title).
 * The UI changes these while a turn is running, through the engine daemon or
 * this host; a turn's save must not put back the values it read at its start.
 */
const USER_FIELDS = ['pinned', 'tags', 'order', 'mode', 'disabledTools', 'offline', 'incognito', 'autoModel', 'autoQuality', 'autoProviderSwitch', 'thinking', 'chatType', 'imageParams', 'workspaceId', 'supportingWorkspaceIds', 'attachedPaths', 'specLinked', 'queue'] as const;

/**
 * Save a chat a running turn has held in memory, keeping whatever the user
 * changed on disk since: the fields above as they are on disk, and the title
 * when the user has named the chat themselves (`titleAuto === false`).
 */
export function saveTurnSession(s: Session): void {
  const disk = getSession(s.id);
  if (disk) {
    const target = s as unknown as Record<string, unknown>;
    const source = disk as unknown as Record<string, unknown>;
    for (const key of USER_FIELDS) {
      if (key in source) target[key] = source[key];
      else delete target[key];
    }
    if (disk.titleAuto === false) {
      s.title = disk.title;
      s.titleAuto = false;
    }
  }
  saveSession(s);
}

export function saveSession(s: Session): void {
  s.updatedAt = Date.now();
  const file = pathFor(s.id);
  writeAtomic(file, JSON.stringify(s, null, 2));
  remember(file, s);
}

export function deleteSession(id: string): void {
  const file = pathFor(id);
  summaryCache.delete(file);
  if (existsSync(file)) rmSync(file);
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

/** The fields `setSessionOptions` may change (crates/nekko-store/src/write.rs keeps the same list). */
const OPTION_KEYS = ['title', 'pinned', 'tags', 'order', 'mode', 'disabledTools', 'offline', 'incognito', 'autoModel', 'autoQuality', 'autoProviderSwitch', 'thinking', 'providerId', 'modelId', 'plan', 'chatType', 'imageParams'] as const;

/** Patch per-chat options (title, pin, mode, disabled tools, offline, incognito, brain). */
export function setSessionOptions(
  id: string,
  patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'order' | 'mode' | 'disabledTools' | 'offline' | 'incognito' | 'autoModel' | 'autoQuality' | 'autoProviderSwitch' | 'thinking' | 'providerId' | 'modelId' | 'plan' | 'chatType' | 'imageParams'>>,
): Session | null {
  const s = getSession(id);
  if (!s) return null;
  // Only the options this signature names: the patch arrives over the wire, and
  // assigning it whole would let a caller replace any field, the transcript included.
  for (const [key, value] of Object.entries(patch)) {
    if ((OPTION_KEYS as readonly string[]).includes(key)) (s as unknown as Record<string, unknown>)[key] = value;
  }
  // A title the user typed is theirs; the auto-title pass may not overwrite it.
  if (patch.title !== undefined) s.titleAuto = false;
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
