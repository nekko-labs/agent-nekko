import { execFile, spawn, type ChildProcess, type ExecFileOptions } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import type { ToolCall, ToolResult, AppSettings, ChatMode } from '@agent-nekko/shared';
import { classifyCommand } from '@agent-nekko/core';
import { recordOriginal } from './changes.js';
import { appendAgentTerminal } from './terminal.js';

const dedicatedBrowsers = new Set<string>();
const browsers = new Map<string, { client: import('@browserbasehq/stagehand').Stagehand; mode: string; port?: number }>();

/** Kill the command's shell and descendants, not just the shell holding its pipes. */
function stopCommandTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('exit', (code) => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill(); }
  }
}

/** execFile does not forward detached; spawn is needed for Unix group cancellation. */
function runShell(file: string, args: string[], options: ExecFileOptions & { detached: boolean; encoding: 'utf8' }, callback: (error: Error | null, stdout: string, stderr: string) => void): ChildProcess {
  if (process.platform === 'win32') return execFile(file, args, options, callback);
  const child = spawn(file, args, { cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let failure: Error | null = null;
  const collect = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
    if (failure) return;
    if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > (options.maxBuffer ?? 1024 * 1024)) {
      failure = new Error('Command output exceeded maxBuffer');
      stopCommandTree(child);
    }
  };
  child.stdout!.on('data', chunk => collect(chunk, 'stdout'));
  child.stderr!.on('data', chunk => collect(chunk, 'stderr'));
  child.on('error', error => { failure = error; });
  child.on('close', (code, signal) => callback(failure ?? (code === 0 ? null : new Error(`Command failed: ${file}\n${stderr}`)), stdout, stderr));
  return child;
}

export interface ToolHostOptions {
  settings: AppSettings;
  /** Resolve relative paths against the first workspace root. */
  defaultCwd?: string;
  /**
   * Called when a command needs approval. Resolves true to proceed. The host
   * wires this to the renderer's approval prompt.
   */
  requestApproval: (call: ToolCall, reason: string, severity: 'low' | 'medium' | 'high') => Promise<boolean>;
  /** Per-chat tool-execution policy (defaults to guardrails). */
  mode?: ChatMode;
  /** Chat this tool runs for, used to track file changes for diff/approve. */
  sessionId?: string;
  allowBrowserControl?: boolean;
  /** Stop this turn's shell command and its descendants when the user stops the agent. */
  signal?: AbortSignal;
}

/** Whether a mutating tool needs an up-front confirm in this mode. */
function asksEverything(opts: ToolHostOptions): boolean {
  return opts.mode === 'ask' || opts.settings.sandboxMode === 'ask-everything';
}

/** Roots the workspace-jail sandbox confines file access to. */
function jailRoots(settings: AppSettings): string[] {
  return settings.workspaces.map((w) => resolve(w.path));
}

function resolvePath(p: string, opts: ToolHostOptions): string {
  const base = opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

function assertInJail(target: string, opts: ToolHostOptions): void {
  if (opts.settings.sandboxMode !== 'workspace-jail') return;
  const roots = jailRoots(opts.settings);
  if (roots.length === 0) return; // nothing to jail against yet
  const ok = roots.some((root) => {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
  if (!ok) {
    throw new Error(
      `Sandbox: ${target} is outside the workspace folders. Add the folder or switch sandbox mode in Settings.`,
    );
  }
}

const ok = (call: ToolCall, output: string): ToolResult => ({ toolCallId: call.id, output });
const err = (call: ToolCall, output: string): ToolResult => ({ toolCallId: call.id, output, isError: true });

async function controlBrowser(call: ToolCall, opts: ToolHostOptions): Promise<ToolResult> {
  if (!opts.allowBrowserControl || !opts.sessionId) return err(call, 'Browser control is available only in a local desktop chat.');
  const input = call.input as Record<string, unknown>;
  const mode = input.mode;
  const action = input.action;
  if (mode !== 'dedicated' && mode !== 'existing') return err(call, 'Choose dedicated or existing browser mode.');
  if (!['navigate', 'inspect', 'click', 'fill', 'close'].includes(String(action))) return err(call, 'Unsupported browser action.');
  const port = mode === 'existing' ? Number(input.port ?? 9222) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return err(call, 'CDP port must be a local TCP port.');
  const url = action === 'navigate' ? String(input.url ?? '') : '';
  if (action === 'navigate' && !/^https?:\/\//i.test(url)) return err(call, 'Only HTTP(S) pages can be opened.');
  const selector = String(input.selector ?? '');
  if (['click', 'fill'].includes(String(action)) && (!selector || selector.length > 500)) return err(call, 'A CSS selector is required.');
  const existing = browsers.get(opts.sessionId);
  if ((mode === 'existing' && dedicatedBrowsers.has(opts.sessionId)) || (existing && (existing.mode !== mode || existing.port !== port))) return err(call, 'Close the current browser session before switching modes or ports.');
  const approved = await opts.requestApproval(call, `Browser ${mode}: ${action}${url ? ` ${url}` : ''}${selector ? ` ${selector}` : ''}`, 'high');
  if (!approved) return err(call, 'Browser action not approved.');
  if (mode === 'dedicated') {
    const bridgeUrl = process.env.NEKKO_BROWSER_URL;
    const token = process.env.NEKKO_BROWSER_TOKEN;
    if (!bridgeUrl || !token) return err(call, 'In-app browser is unavailable. Restart the desktop app to enable it.');
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, sessionId: opts.sessionId }),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as { output?: string; error?: string };
    if (response.ok) {
      if (action === 'close') dedicatedBrowsers.delete(opts.sessionId);
      else dedicatedBrowsers.add(opts.sessionId);
    }
    return response.ok ? ok(call, result.output ?? '') : err(call, result.error ?? 'In-app browser action failed.');
  }
  if (action === 'close') {
    if (existing) {
      browsers.delete(opts.sessionId);
      await existing.client.close();
    }
    return ok(call, 'Browser session disconnected.');
  }
  let current = existing;
  if (!current) {
    const { localBrowser, Stagehand } = await import('@browserbasehq/stagehand');
    const browser = await localBrowser.connect({ cdpUrl: `http://127.0.0.1:${port}` });
    try {
      current = { client: await Stagehand.create({ browser }), mode, port };
      browsers.set(opts.sessionId, current);
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
  const page = await current.client.browser.context.activePage();
  if (!page) return err(call, 'No active browser tab. Open a page and try again.');
  if (action === 'navigate') await page.goto(url);
  if (action === 'click') await page.locator(selector).click();
  if (action === 'fill') await page.locator(selector).fill(String(input.value ?? ''));
  return ok(call, action === 'fill' ? 'Field filled.' : `${await page.title()}\n${(await page.locator('body').innerText()).slice(0, 6000)}`);
}

/** Execute one tool call, enforcing sandbox + guardrails. */
export async function executeTool(call: ToolCall, opts: ToolHostOptions): Promise<ToolResult> {
  const a = call.input as Record<string, any>;
  try {
    switch (call.name) {
      case 'browser': return await controlBrowser(call, opts);
      case 'read_file': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (!existsSync(p)) return err(call, `File not found: ${p}`);
        const content = readFileSync(p, 'utf8');
        if (a.start_line != null || a.end_line != null) {
          const start = a.start_line ?? 1;
          const end = a.end_line ?? start + 199;
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
            return err(call, 'start_line and end_line must be positive integers, with end_line >= start_line.');
          }
          const lines = content.split('\n');
          const selected = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
          return ok(call, selected.length > 60000 ? selected.slice(0, 60000) + '\n…(truncated; request a smaller line range)' : selected || `(no lines at or after ${start}; ${lines.length} total lines)`);
        }
        return ok(call, content.length > 60000 ? content.slice(0, 60000) + '\n…(truncated; use start_line and end_line to read later lines)' : content);
      }
      case 'write_file': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (asksEverything(opts)) {
          if (!(await opts.requestApproval(call, `Write ${p}`, 'medium'))) return err(call, 'Write not approved by user.');
        }
        await recordOriginal(opts.sessionId, p);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, String(a.content ?? ''), 'utf8');
        return ok(call, `Wrote ${p} (${String(a.content ?? '').length} bytes)`);
      }
      case 'edit_file': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (!existsSync(p)) return err(call, `File not found: ${p}`);
        if (asksEverything(opts)) {
          if (!(await opts.requestApproval(call, `Edit ${p}`, 'medium'))) return err(call, 'Edit not approved by user.');
        }
        const cur = readFileSync(p, 'utf8');
        const count = cur.split(a.old_string).length - 1;
        if (count === 0) return err(call, 'old_string not found in file.');
        if (count > 1) return err(call, `old_string matched ${count} times; make it unique.`);
        await recordOriginal(opts.sessionId, p);
        writeFileSync(p, cur.replace(a.old_string, a.new_string), 'utf8');
        return ok(call, `Edited ${p}`);
      }
      case 'list_dir': {
        const p = resolvePath(a.path, opts);
        assertInJail(p, opts);
        if (!existsSync(p)) return err(call, `Directory not found: ${p}`);
        const entries = readdirSync(p, { withFileTypes: true }).map(
          (e) => (e.isDirectory() ? `${e.name}/` : e.name),
        );
        return ok(call, entries.join('\n') || '(empty)');
      }
      case 'glob': {
        const root = a.path ? resolvePath(a.path, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        assertInJail(root, opts);
        if (!existsSync(root)) return err(call, `Directory not found: ${root}`);
        const matches = globFiles(root, a.pattern);
        return ok(call, matches.slice(0, 200).join('\n') || '(no matches)');
      }
      case 'grep': {
        const root = a.path ? resolvePath(a.path, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        assertInJail(root, opts);
        if (!existsSync(root)) return err(call, `Path not found: ${root}`);
        return ok(call, grepFiles(root, a.pattern).slice(0, 100).join('\n') || '(no matches)');
      }
      case 'bash': {
        const decision = classifyCommand(a.command, opts.settings.guardrails);
        // A deny guardrail is a hard floor in every mode (even YOLO).
        if (decision.action === 'deny') {
          return err(call, `Blocked by guardrail (${decision.matches.map((m) => m.label).join(', ')}).`);
        }
        // YOLO never prompts; Ask always prompts; Guardrails prompts on ask-rules.
        const needsApproval =
          opts.mode === 'yolo'
            ? false
            : asksEverything(opts) || decision.action === 'ask';
        if (needsApproval) {
          const approved = await opts.requestApproval(
            call,
            decision.matches.map((m) => m.label).join(', ') || 'Run command',
            decision.severity,
          );
          if (!approved) return err(call, 'Command not approved by user.');
        }
        const cwd = a.cwd ? resolvePath(a.cwd, opts) : opts.defaultCwd ?? opts.settings.workspaces[0]?.path ?? process.cwd();
        const mirror = (text: string) => {
          if (opts.sessionId) appendAgentTerminal(opts.sessionId, opts.settings.workspaces.find((w) => w.path === cwd)?.id, text.replace(/[^\x09\x0a\x20-\x7e\u0080-\uffff]/g, '').replace(/\n/g, '\r\n'));
        };
        if (opts.signal?.aborted) return err(call, 'Command cancelled.');
        mirror(`$ ${a.command}\n`);
        try {
          const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveP, reject) => {
            let stopped: 'cancelled' | 'timed out' | null = null;
            let timer: ReturnType<typeof setTimeout>;
            const onAbort = () => {
              stopped = 'cancelled';
              stopCommandTree(child);
            };
            // A separate process group on Unix lets Stop and timeout kill all
            // descendants. On Windows taskkill /T does the same for cmd.exe.
            const options: ExecFileOptions & { detached: boolean; encoding: 'utf8' } = { cwd, maxBuffer: 10 * 1024 * 1024, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', encoding: 'utf8' };
            if (typeof a.command !== 'string') throw new TypeError(`The "command" argument must be of type string. Received ${typeof a.command === 'number' ? `type number (${a.command})` : String(a.command)}`);
            const child = runShell(process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh', process.platform === 'win32' ? ['/d', '/s', '/c', a.command] : ['-c', a.command], options, (error: Error | null, stdout: string, stderr: string) => {
              // Keep the previous exec error format (without the explicit shell).
              if (error) error.message = error.message.replace(/^Command failed: .*?\r?\n/, `Command failed: ${a.command}\n`);
              clearTimeout(timer);
              opts.signal?.removeEventListener('abort', onAbort);
              if (stopped) reject(Object.assign(new Error(`Command ${stopped}.`), { stdout, stderr }));
              else if (error) reject(Object.assign(error, { stdout, stderr }));
              else resolveP({ stdout, stderr });
            });
            timer = setTimeout(() => { stopped = 'timed out'; stopCommandTree(child); }, 120_000);
            opts.signal?.addEventListener('abort', onAbort, { once: true });
            if (opts.signal?.aborted) onAbort();
            child.stdout?.on('data', (chunk: Buffer | string) => mirror(String(chunk)));
            child.stderr?.on('data', (chunk: Buffer | string) => mirror(String(chunk)));
          });
          const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : '')).slice(0, 60000) || '(no output)';
          if (!stdout && !stderr) mirror('(no output)\n');
          return ok(call, output);
        } catch (e: any) {
          const output = `Command failed: ${e.message}\n${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 60000);
          mirror(`[command failed]\n`);
          return err(call, output);
        }
      }
      default:
        return err(call, `Unknown tool: ${call.name}`);
    }
  } catch (e) {
    return err(call, (e as Error).message);
  }
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'target', '.venv', 'coverage']);

/** Minimal glob supporting **, *, and ?, no external dependency. */
function globFiles(root: string, pattern: string): string[] {
  const re = globToRegExp(pattern);
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const rel = relative(root, full).replace(/\\/g, '/');
        if (re.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

function grepFiles(root: string, pattern: string): string[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return [`Invalid regex: ${pattern}`];
  }
  const out: string[] = [];
  const fileRoot = statSync(root).isFile();
  const scan = (full: string) => {
    try {
      if (statSync(full).size > 1_000_000) return;
      const lines = readFileSync(full, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (re.test(line)) {
          out.push(`${(fileRoot ? basename(full) : relative(root, full)).replace(/\\/g, '/')}:${idx + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    } catch {
      /* binary or unreadable */
    }
  };
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || out.length > 100) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        scan(full);
      }
    }
  };
  if (fileRoot) scan(root);
  else walk(root);
  return out;
}
