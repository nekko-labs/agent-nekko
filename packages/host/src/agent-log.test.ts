import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDataDir } from './paths.js';
import { agentLogPath, appendAgentLog, flushAgentLogs, readAgentLog } from './agent-log.js';
import { deleteSession, listSessions, saveSession } from './sessions.js';
import { appendAgentTerminal, terminalSnapshot } from './terminal.js';

beforeEach(() => setDataDir(mkdtempSync(join(tmpdir(), 'nekko-agent-log-'))));
describe('session command log persistence', () => {
  it('appends asynchronously in order alongside session JSON without polluting discovery', async () => {
    saveSession({ id: 'persist', title: 'Test', createdAt: 1, updatedAt: 1, messages: [] });
    appendAgentLog('persist', 'first\r\n');
    appendAgentLog('persist', 'second\r\n');
    await flushAgentLogs();
    expect(readFileSync(agentLogPath('persist'), 'utf8')).toBe('first\r\nsecond\r\n');
    expect(listSessions().map(s => s.id)).toEqual(['persist']);
  });
  it('loads a disk-only log after restart and includes later live output', async () => {
    const path = agentLogPath('restored');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '$ old\r\nold output\r\n');
    expect((await terminalSnapshot('agent_restored'))?.buffer).toContain('old output');
    expect((await terminalSnapshot('agent_restored'))?.info.running).toBe(false);
    appendAgentTerminal('restored', undefined, '$ new\r\n');
    expect((await terminalSnapshot('agent_restored'))?.buffer).toBe('$ old\r\nold output\r\n$ new\r\n');
  });
  it('bounds snapshot reads while retaining full disk history and valid UTF-8', async () => {
    appendAgentLog('bounded', 'first' + '猫'.repeat(30));
    expect(await readAgentLog('bounded', 10)).toBe('猫猫猫');
    expect(readFileSync(agentLogPath('bounded'), 'utf8')).toContain('first');
  });
  it('queues session deletion after pending writes and rejects later recreation', async () => {
    appendAgentLog('deleted', 'output');
    deleteSession('deleted');
    appendAgentLog('deleted', 'late output');
    await flushAgentLogs();
    expect(existsSync(agentLogPath('deleted'))).toBe(false);
  });
  it('reports persistence failure without throwing from live append', async () => {
    const path = agentLogPath('failure');
    mkdirSync(path, { recursive: true });
    expect(() => appendAgentLog('failure', 'live output')).not.toThrow();
    await expect(readAgentLog('failure', 100)).rejects.toThrow();
    // Remove the deliberately invalid directory before queued cleanup.
    const { rmSync } = await import('node:fs');
    rmSync(path, { recursive: true });
    deleteSession('failure');
    await flushAgentLogs();
  });

  it('rejects paths outside session storage and returns null for missing history', async () => {
    expect(() => appendAgentLog('../escape', 'bad')).toThrow('Invalid');
    expect(await readAgentLog('missing', 100)).toBeNull();
  });
});

// Real process boundaries prove restoration does not depend on module memory.
it('drains large queued output before exit and restores it in a fresh process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nekko-log-process-'));
  const child = join(root, 'child.cjs');
  buildSync({ stdin: { contents: `
    import { setDataDir } from './paths';
    import { appendAgentLog, flushAgentLogs, readAgentLog } from './agent-log';
    setDataDir(process.argv[2]);
    async function main() {
      if (process.argv[3] === 'write') {
        for (let i=0;i<256;i++) appendAgentLog('restart', 'x'.repeat(65536));
        appendAgentLog('restart', '\\r\\nEND');
        await flushAgentLogs();
        process.exit(0);
      }
      const tail = await readAgentLog('restart', 256*1024);
      if (!tail || Buffer.byteLength(tail)>256*1024 || !tail.endsWith('END')) process.exit(2);
      console.log(tail.length);
    }
    main().catch(e=>{console.error(e);process.exit(1)});
  `, resolveDir: resolve('src') }, outfile: child, bundle: true, platform: 'node', format: 'cjs' });
  for (const mode of ['write', 'read']) {
    const result = spawnSync(process.execPath, [child, root, mode], { encoding: 'utf8', timeout: 30000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  expect(readFileSync(join(root, 'sessions/restart.commands.log')).length).toBeGreaterThan(16*1024*1024);
}, 60000);
