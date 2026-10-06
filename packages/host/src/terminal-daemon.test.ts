import { mkdtempSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import { saveSession } from './sessions.js';
import { appendAgentTerminal, createTerminal, finishAgentTerminal, listTerminals, terminalSnapshot, useTerminalDaemon, writeTerminal } from './terminal.js';

/**
 * Under the engine daemon the host keeps only the agent command logs and
 * forwards every pty call. This fakes the daemon's HTTP side and checks what
 * reaches it.
 */
const TOKEN = 'daemon-test-token-0123456789';

let server: Server | null = null;
const calls: { channel: string; args: unknown[]; auth?: string }[] = [];

async function fakeDaemon(): Promise<string> {
  calls.length = 0;
  server = createServer(async (req, res) => {
    // The host also opens an events socket here; only calls are recorded.
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const { args } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const channel = decodeURIComponent((req.url ?? '').replace('/api/', ''));
    calls.push({ channel, args, auth: req.headers.authorization });
    const reply = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (channel === 'terminal:create') return reply({ id: 'term_daemon_1', title: 'pwsh', cwd: '/', shell: 'pwsh', createdAt: 1, running: true });
    if (channel === 'terminals:list:native') return reply([{ id: 'term_daemon_1', title: 'pwsh', cwd: '/', shell: 'pwsh', createdAt: 1, running: true }]);
    if (channel === 'terminal:snapshot') return reply({ info: { id: args[0] }, buffer: 'hi', cols: 80, rows: 24 });
    reply(null);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeAll(() => setDataDir(mkdtempSync(join(tmpdir(), 'nekko-term-daemon-'))));

afterEach(() => {
  useTerminalDaemon(null);
  server?.close();
  server = null;
});

describe('terminals under the engine daemon', () => {
  it('creates ptys in the daemon, with its token', async () => {
    useTerminalDaemon({ url: await fakeDaemon(), token: TOKEN });
    const t = await createTerminal({ cols: 90 });
    expect(t.id).toBe('term_daemon_1');
    expect(calls[0]).toMatchObject({ channel: 'terminal:create', args: [{ cols: 90 }], auth: `Bearer ${TOKEN}` });
  });

  it('resolves chat terminals to shared folders when git isolation is off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-term-cwd-'));
    const repo = join(dir, 'repo');
    const wt = join(dir, 'wt');
    mkdirSync(repo);
    mkdirSync(wt);
    saveSettings({ workspaces: [{ id: 'repo', name: 'Repo', path: repo }] });
    saveSession({ id: 's_terminal_shared', title: 'Shared', workspaceId: 'repo', gitIsolation: false, gitWorktrees: { repo: { sourceRoot: repo, root: wt, path: wt, branch: 'nekko/test', notice: '' } }, messages: [], createdAt: 1, updatedAt: 1 });
    useTerminalDaemon({ url: await fakeDaemon(), token: TOKEN });
    await createTerminal({ sessionId: 's_terminal_shared', workspaceId: 'repo' });
    expect(calls[0]).toMatchObject({ channel: 'terminal:create', args: [{ workspaceId: 'repo', cwd: repo }] });
  });

  it('lists the daemon ptys beside its own agent logs', async () => {
    useTerminalDaemon({ url: await fakeDaemon(), token: TOKEN });
    appendAgentTerminal('s-daemon-test', undefined, 'ran a command\r\n');
    const ids = (await listTerminals()).map((t) => t.id);
    expect(ids).toContain('term_daemon_1');
    expect(ids).toContain('agent_s-daemon-test');
  });

  it('marks a finished agent log as stopped without losing its output', async () => {
    appendAgentTerminal('s-finished', undefined, 'command output');
    finishAgentTerminal('s-finished');
    const snapshot = await terminalSnapshot('agent_s-finished');
    expect(snapshot?.info.running).toBe(false);
    expect(snapshot?.buffer).toContain('command output');
  });

  it('returns null before the first command and preserves output across subsequent turns', async () => {
    useTerminalDaemon({ url: await fakeDaemon(), token: TOKEN });
    expect(await terminalSnapshot('agent_s-lazy')).toBeNull();
    appendAgentTerminal('s-lazy', undefined, '$ first\r\nfirst output\r\n');
    finishAgentTerminal('s-lazy');
    appendAgentTerminal('s-lazy', undefined, '$ second\r\nsecond output\r\n');
    const snapshot = await terminalSnapshot('agent_s-lazy');
    expect(snapshot?.info.running).toBe(true);
    expect(snapshot?.info.exitCode).toBeUndefined();
    expect(snapshot?.buffer).toBe('$ first\r\nfirst output\r\n$ second\r\nsecond output\r\n');
    expect(calls).toEqual([]);
    finishAgentTerminal('s-lazy');
    expect((await terminalSnapshot('agent_s-lazy'))?.info.running).toBe(false);
  });

  it('keeps agent logs local and forwards everything else', async () => {
    useTerminalDaemon({ url: await fakeDaemon(), token: TOKEN });
    appendAgentTerminal('s-local', undefined, 'local output');
    const local = await terminalSnapshot('agent_s-local');
    expect(local?.buffer).toContain('local output');
    expect(calls.some((c) => c.channel === 'terminal:snapshot')).toBe(false);

    const remote = await terminalSnapshot('term_daemon_1');
    expect(remote?.buffer).toBe('hi');
    writeTerminal('term_daemon_1', 'ls\r');
    for (let i = 0; i < 50 && !calls.some((c) => c.channel === 'terminal:write'); i++) await new Promise((r) => setTimeout(r, 10));
    expect(calls.find((c) => c.channel === 'terminal:write')?.args).toEqual(['term_daemon_1', 'ls\r']);
  });
});
