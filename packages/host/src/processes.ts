import { assertHostExecution } from './indirect-execution-guard.js';
import { spawn, type ChildProcess } from 'child_process';
import { appendAgentTerminal } from './terminal.js';

/**
 * Long-running commands an agent starts and comes back to: a dev server, a
 * watcher, a build that takes ten minutes. The `bash` tool is a round trip
 * with a two-minute limit, so agents used to hide these behind `start /b` or
 * `&`, lost their output, and left them running. Here a process runs
 * detached from the turn, its output is buffered until read (and mirrored
 * into the chat's agent terminal), and it dies with the chat's Stop, with
 * `kill_process`, or when the app quits. The same idea as Claude Code's
 * `run_in_background` and Codex's exec sessions.
 */

export interface ProcessInfo {
  id: string;
  sessionId: string;
  pid: number | undefined;
  command: string;
  cwd: string;
  name?: string;
  startedAt: number;
  /** Set when the process has exited. */
  exitCode?: number | null;
  exitSignal?: string | null;
  endedAt?: number;
}

interface Entry {
  info: ProcessInfo;
  child: ChildProcess;
  /** Output not yet handed to the agent. */
  unread: string;
  /** Total output kept for `read_process` with `all`, tail-trimmed. */
  all: string;
  /** Wakes a `read_process` that is waiting for output or exit. */
  wake: Set<() => void>;
}

/** Output kept per process; the head falls off past this. */
export const PROCESS_BUFFER_MAX = 1_000_000;
/** The most one read hands back. */
export const READ_MAX = 60_000;
/** The longest a `read_process` may wait for new output. */
export const READ_WAIT_MAX_MS = 120_000;
/** Processes one chat may have running at once. */
export const PROCESS_LIMIT = 8;

const processes = new Map<string, Entry>();
let counter = 0;

function nextId(): string {
  counter++;
  return `p_${Date.now().toString(36)}_${counter.toString(36)}`;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `…\n${s.slice(s.length - max)}`;
}

/** The shell command line used by the `bash` tool, so behaviour matches it. */
function shell(command: string): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-c', command] };
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    const grace = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 5_000);
    child.once('exit', () => clearTimeout(grace));
  }
}

function notify(entry: Entry): void {
  for (const fn of entry.wake) fn();
  entry.wake.clear();
}

/** Start a command for a chat. Throws when the chat already has `PROCESS_LIMIT` running. */
export function startProcess(opts: { sessionId: string; workspaceId?: string; command: string; cwd: string; name?: string }): ProcessInfo {
  assertHostExecution(opts.sessionId, 'Host background process');
  const running = [...processes.values()].filter((e) => e.info.sessionId === opts.sessionId && e.info.exitCode === undefined);
  if (running.length >= PROCESS_LIMIT) {
    throw new Error(`This chat already has ${PROCESS_LIMIT} processes running. Stop one with kill_process first.`);
  }
  const { file, args } = shell(opts.command);
  const child = spawn(file, args, {
    cwd: opts.cwd,
    detached: process.platform !== 'win32',
    windowsHide: true,
    // As the bash tool: cmd.exe gets the command line verbatim, not re-quoted.
    windowsVerbatimArguments: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
  });
  const info: ProcessInfo = { id: nextId(), sessionId: opts.sessionId, pid: child.pid, command: opts.command, cwd: opts.cwd, startedAt: Date.now() };
  if (opts.name) info.name = opts.name;
  const entry: Entry = { info, child, unread: '', all: '', wake: new Set() };
  processes.set(info.id, entry);
  const label = info.name ?? info.id;
  appendAgentTerminal(opts.sessionId, opts.workspaceId, `$ ${opts.command}  [${label}, background]\n`);
  const onData = (chunk: Buffer | string) => {
    const text = String(chunk);
    entry.unread = clip(entry.unread + text, PROCESS_BUFFER_MAX);
    entry.all = clip(entry.all + text, PROCESS_BUFFER_MAX);
    appendAgentTerminal(opts.sessionId, opts.workspaceId, text);
    notify(entry);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (e) => {
    onData(`[could not start: ${e.message}]\n`);
    info.exitCode = -1;
    info.endedAt = Date.now();
    notify(entry);
  });
  child.on('exit', (code, signal) => {
    info.exitCode = code;
    info.exitSignal = signal;
    info.endedAt = Date.now();
    appendAgentTerminal(opts.sessionId, opts.workspaceId, `[${label} exited${code !== null ? ` with code ${code}` : signal ? ` on ${signal}` : ''}]\n`);
    notify(entry);
  });
  return { ...info };
}

export function getProcess(id: string): ProcessInfo | undefined {
  const e = processes.get(id);
  return e ? { ...e.info } : undefined;
}

/** The chat's processes, running first. */
export function listProcesses(sessionId: string): ProcessInfo[] {
  return [...processes.values()]
    .filter((e) => e.info.sessionId === sessionId)
    .map((e) => ({ ...e.info }))
    .sort((a, b) => Number(a.exitCode !== undefined) - Number(b.exitCode !== undefined) || a.startedAt - b.startedAt);
}

/**
 * Output since the last read (or everything kept, with `all`), waiting up to
 * `waitMs` for something new when there is nothing yet and the process is
 * still running. An exited process hands back what is left and is forgotten
 * once drained, so ids do not pile up.
 */
export async function readProcess(id: string, opts: { waitMs?: number; all?: boolean } = {}): Promise<{ info: ProcessInfo; output: string; truncated: boolean } | undefined> {
  const entry = processes.get(id);
  if (!entry) return undefined;
  const waitMs = Math.min(Math.max(0, opts.waitMs ?? 0), READ_WAIT_MAX_MS);
  if (!entry.unread && entry.info.exitCode === undefined && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, waitMs);
      function done() {
        clearTimeout(timer);
        entry!.wake.delete(done);
        resolve();
      }
      entry.wake.add(done);
    });
  }
  const source = opts.all ? entry.all : entry.unread;
  const truncated = source.length > READ_MAX;
  const output = truncated ? source.slice(source.length - READ_MAX) : source;
  entry.unread = '';
  if (entry.info.exitCode !== undefined) processes.delete(id);
  return { info: { ...entry.info }, output, truncated };
}

/** Stop one process; false when there is none by that id. */
export function killProcess(id: string): boolean {
  const entry = processes.get(id);
  if (!entry) return false;
  killTree(entry.child);
  return true;
}

/** Stop every process a chat started (Stop, archive, delete). Returns how many were running. */
export function killSessionProcesses(sessionId: string): number {
  let n = 0;
  for (const entry of processes.values()) {
    if (entry.info.sessionId !== sessionId || entry.info.exitCode !== undefined) continue;
    killTree(entry.child);
    n++;
  }
  return n;
}

/** Stop everything. Called when the host shuts down. */
export function killAllProcesses(): void {
  for (const entry of processes.values()) {
    if (entry.info.exitCode === undefined) killTree(entry.child);
  }
}

/** A line about a process, for tool output. */
export function describeProcess(info: ProcessInfo): string {
  const label = info.name ? `${info.id} (${info.name})` : info.id;
  const state =
    info.exitCode === undefined
      ? `running for ${Math.round((Date.now() - info.startedAt) / 1000)} s${info.pid ? `, pid ${info.pid}` : ''}`
      : info.exitCode === null
        ? `exited on ${info.exitSignal ?? 'signal'}`
        : `exited with code ${info.exitCode}`;
  return `${label}: ${state}, started with \`${info.command}\` in ${info.cwd}`;
}

process.once('exit', killAllProcesses);
