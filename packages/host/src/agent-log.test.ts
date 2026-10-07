import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
