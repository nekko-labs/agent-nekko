import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dataDir } from './store.js';

const pending = new Map<string, Promise<void>>();
const failures = new Map<string, Error>();
const removed = new Set<string>();

/** Sidecars deliberately do not end in .json, so session discovery ignores them. */
export function agentLogPath(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid command log session ID');
  return join(dataDir(), 'sessions', `${sessionId}.commands.log`);
}

function enqueue(path: string, operation: () => Promise<void>): void {
  const previous = pending.get(path) ?? Promise.resolve();
  const task = previous.then(operation).catch(error => {
    failures.set(path, error instanceof Error ? error : new Error(String(error)));
    console.warn('Could not persist session command log:', error);
  });
  pending.set(path, task);
  void task.then(() => { if (pending.get(path) === task) pending.delete(path); });
}

/** Output delivery remains synchronous; disk writes are ordered independently. */
export function appendAgentLog(sessionId: string, data: string): void {
  const path = agentLogPath(sessionId);
  if (removed.has(path)) return;
  enqueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, data, { encoding: 'utf8', mode: 0o600 });
  });
}

/** Reads wait for prior writes, then read only the bounded tail of the sidecar. */
export async function readAgentLog(sessionId: string, maxBytes: number): Promise<string | null> {
  const path = agentLogPath(sessionId);
  await pending.get(path);
  if (failures.has(path)) throw failures.get(path);
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let offset = 0;
    // Skip a truncated UTF-8 continuation sequence at the tail boundary.
    while (offset < bytesRead && (buffer[offset] & 0xc0) === 0x80) offset++;
    return buffer.subarray(offset, bytesRead).toString('utf8');
  } finally { await file.close(); }
}

/** Queue removal after existing writes so deletion cannot recreate the sidecar. */
export function deleteAgentLog(sessionId: string): void {
  const path = agentLogPath(sessionId);
  removed.add(path);
  enqueue(path, async () => {
    await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    failures.delete(path);
  });
}

/** Explicit drain for graceful shutdown and deterministic persistence checks. */
export async function flushAgentLogs(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
  if (failures.size) throw [...failures.values()][0];
}
