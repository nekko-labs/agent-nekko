import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createDispatcher } from './dispatch.js';
import type { Host } from './host.js';
import { setDataDir } from './paths.js';
import { appendAgentLog, flushAgentLogs, readAgentLog } from './agent-log.js';

it('daemon callback rejects failed unlink rather than acknowledging deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-log-failure-'));
  setDataDir(dir);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const path = join(dir, 'sessions', 'failed.commands.log');
  mkdirSync(path, { recursive: true });
  try {
    const dispatch = createDispatcher({} as Host);
    await expect(dispatch('sessions:deleteAgentLog', ['failed'])).rejects.toThrow();
    await expect(flushAgentLogs()).rejects.toThrow();
    rmSync(path, { recursive: true });
    await dispatch('sessions:deleteAgentLog', ['failed']);
    await flushAgentLogs();
  } finally {
    warn.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('daemon deletion callback orders removal after queued writes and suppresses future appends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-log-callback-'));
  setDataDir(dir);
  try {
    const dispatch = createDispatcher({} as Host);
    for (const id of ['cleared', 'deleted', 'missing']) {
      if (id !== 'missing') {
        appendAgentLog(id, 'first');
        appendAgentLog(id, 'queued');
      }
      await dispatch('sessions:deleteAgentLog', [id]);
      appendAgentLog(id, 'late');
      await flushAgentLogs();
      expect(await readAgentLog(id, 1024)).toBeNull();
      appendAgentLog(id, 'later');
      await flushAgentLogs();
      expect(await readAgentLog(id, 1024)).toBeNull();
    }
    appendAgentLog('retained', 'keep');
    await flushAgentLogs();
    expect(await readAgentLog('retained', 1024)).toBe('keep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
