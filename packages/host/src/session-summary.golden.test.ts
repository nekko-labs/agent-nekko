import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { summarizeSession } from '@nekko-agent/shared';

/**
 * The summaries the engine daemon's Rust port (crates/nekko-store) must
 * reproduce exactly. This test keeps the expected file honest: change
 * `summarizeSession` and it fails until the golden file is rewritten with
 * `UPDATE_GOLDEN=1`, which then makes the Rust test hold the port to the change.
 */
const golden = join(__dirname, '..', '..', '..', 'crates', 'nekko-store', 'tests', 'golden');

describe('session summary golden set', () => {
  it('matches what summarizeSession produces for every fixture', () => {
    const files = readdirSync(join(golden, 'sessions')).filter((f) => f.endsWith('.json')).sort();
    const actual: Record<string, unknown> = {};
    for (const f of files) {
      const session = JSON.parse(readFileSync(join(golden, 'sessions', f), 'utf8')) as Session;
      let summary: unknown = null;
      // The host's lister skips a file summarizeSession throws on; so does the port.
      try { summary = JSON.parse(JSON.stringify(summarizeSession(session))); } catch { summary = null; }
      actual[f.replace(/\.json$/, '')] = summary;
    }
    const path = join(golden, 'summaries.json');
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(actual);
  });
});
