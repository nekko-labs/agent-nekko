import { exec } from 'child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type { ToolCall, ToolResult, AppSettings, ChatMode } from '@agent-nekko/shared';
import { classifyCommand } from '@agent-nekko/core';
import { recordOriginal } from './changes.js';
import { appendAgentTerminal } from './terminal.js';

const browsers = new Map<string, { client: import('@browserbasehq/stagehand').Stagehand; mode: string; port?: number }>();

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
  if (existing && (existing.mode !== mode || existing.port !== port)) return err(call, 'Close the current browser session before switching modes or ports.');
  const approved = await opts.requestApproval(call, `Browser ${mode}: ${action}${url ? ` ${url}` : ''}${selector ? ` ${selector}` : ''}`, 'high');
  if (!approved) return err(call, 'Browser action not approved.');
  if (action === 'close') {
    if (existing) {
      browsers.delete(opts.sessionId);
      await existing.client.close();
      if (existing.mode === 'dedicated') {
        try { await existing.client.browser.close(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; }
      }
    }
    return ok(call, 'Browser session disconnected.');
  }
  let current = existing;
  if (!current) {
    const { localBrowser, Stagehand } = await import('@browserbasehq/stagehand');
    const brave = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
    const browser = mode === 'dedicated'
      ? await localBrowser.launch({ headless: false, ...(process.platform === 'win32' && existsSync(brave) ? { executablePath: brave } : {}) })
      : await localBrowser.connect({ cdpUrl: `http://127.0.0.1:${port}` });
    try {
      current = { client: await Stagehand.create({ browser }), mode, port };
      browsers.set(opts.sessionId, current);
    } catch (error) {
      if (mode === 'dedicated') await browser.close();
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
        return ok(call, content.length > 60000 ? content.slice(0, 60000) + '\n…(truncated)' : content);
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
        const root = opts.settings.workspaces[0]?.path ?? opts.defaultCwd ?? process.cwd();
        const matches = globFiles(root, a.pattern);
        return ok(call, matches.slice(0, 200).join('\n') || '(no matches)');
      }
      case 'grep': {
        const root = a.path ? resolvePath(a.path, opts) : opts.settings.workspaces[0]?.path ?? process.cwd();
        assertInJail(root, opts);
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
        const cwd = a.cwd ? resolvePath(a.cwd, opts) : opts.settings.workspaces[0]?.path ?? process.cwd();
        const mirror = (text: string) => {
          if (opts.sessionId) appendAgentTerminal(opts.sessionId, opts.settings.workspaces.find((w) => w.path === cwd)?.id, text.replace(/[^\x09\x0a\x20-\x7e\u0080-\uffff]/g, '').replace(/\n/g, '\r\n'));
        };
        mirror(`$ ${a.command}\n`);
        try {
          const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveP, reject) => {
            const child = exec(a.command, { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error) reject(Object.assign(error, { stdout, stderr }));
              else resolveP({ stdout, stderr });
            });
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
        try {
          if (statSync(full).size > 1_000_000) continue;
          const lines = readFileSync(full, 'utf8').split('\n');
          lines.forEach((line, idx) => {
            if (re.test(line)) {
              out.push(`${relative(root, full).replace(/\\/g, '/')}:${idx + 1}: ${line.trim().slice(0, 200)}`);
            }
          });
        } catch {
          /* binary or unreadable */
        }
      }
    }
  };
  walk(root);
  return out;
}
