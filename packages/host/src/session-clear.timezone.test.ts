import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const fixtures = JSON.parse(readFileSync(join(__dirname,
  '../../../crates/nekko-store/tests/timezone/clear-cutoffs.json'), 'utf8')) as {
  name: string; timezone: string; nowMs: number; scope: 'today' | 'month'; expectedMs: number;
}[];

for (const fixture of fixtures) {
  it(`JS Date cutoff parity: ${fixture.name}`, () => {
    // A fresh process pins TZ even on Windows, without changing the test worker.
    // Match clearSessions setter order, including the gap-adjusted clock.
    const script = `
      const day = new Date(${fixture.nowMs});
      day.setHours(0, 0, 0, 0);
      const month = new Date(day);
      month.setDate(1);
      console.log(JSON.stringify({
        zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        cutoff: ${fixture.scope === 'month' ? 'month' : 'day'}.getTime(),
      }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, TZ: fixture.timezone },
      windowsHide: true,
      encoding: 'utf8',
    }));
    expect(result.zone).toBe(fixture.timezone);
    expect(result.cutoff).toBe(fixture.expectedMs);
  });
}
