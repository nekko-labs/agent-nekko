import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { expect, it, vi } from 'vitest';
import { setDataDir } from './paths.js';
import { clearSessions, listSessionSummaries } from './sessions.js';
import { flushAgentLogs } from './agent-log.js';

const golden = join(__dirname, '../../../crates/nekko-store/tests/golden/clear.json');
it('records real TS clear semantics at local calendar boundaries', async () => {
  const now = new Date(2026, 9, 15, 12).getTime();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const actual = [];
  try {
    for (const scope of ['today', 'month', 'all'] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'nekko-clear-'));
      try {
        setDataDir(dir);
        const day = new Date(now); day.setHours(0, 0, 0, 0);
        const month = new Date(day); month.setDate(1);
        const cutoff = scope === 'month' ? month.getTime() : day.getTime();
        const values = [cutoff - 1, cutoff, cutoff + 1, now + 86400000, 0, null, String(cutoff), 'invalid', undefined];
        mkdirSync(join(dir, 'sessions'));
        const sessions = values.map((updatedAt, i) => ({ id: `s_${i}`, title: 'Test', messages: [], createdAt: now, updatedAt }));
        for (const s of sessions) {
          writeFileSync(join(dir, 'sessions', `${s.id}.json`), JSON.stringify(s));
          writeFileSync(join(dir, 'sessions', `${s.id}.commands.log`), 'log');
        }
        writeFileSync(join(dir, 'sessions', 'broken.json'), '{');
        await listSessionSummaries(); // Warm the summary cache before deletion.
        const count = clearSessions(scope);
        await flushAgentLogs();
        const remaining = sessions.filter(s => existsSync(join(dir, 'sessions', `${s.id}.json`))).map(s => s.id);
        const logs = sessions.filter(s => existsSync(join(dir, 'sessions', `${s.id}.commands.log`))).map(s => s.id);
        expect(logs).toEqual(remaining);
        expect(existsSync(join(dir, 'sessions', 'broken.json'))).toBe(true);
        expect((await listSessionSummaries()).map(s => s.id).sort()).toEqual([...remaining].sort());
        actual.push({ scope, cutoff, sessions, count, remaining });
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // Store relative timestamps so the golden is independent of the test machine's zone.
    const normalized = actual.map(c => ({ ...c, cutoff: 1000, sessions: c.sessions.map(s => ({ ...s, createdAt: 0, updatedAt: typeof s.updatedAt === 'number' && s.updatedAt !== 0 ? s.updatedAt - c.cutoff + 1000 : typeof s.updatedAt === 'string' && s.updatedAt !== 'invalid' ? '1000' : s.updatedAt })) }));
    if (process.env.UPDATE_GOLDEN) writeFileSync(golden, `${JSON.stringify(normalized, null, 2)}\n`);
    expect(JSON.parse(readFileSync(golden, 'utf8'))).toEqual(normalized);
  } finally { vi.useRealTimers(); }
});
