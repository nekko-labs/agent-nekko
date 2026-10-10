/**
 * The reply log: how each agent reply ended (finished, loop detector, runaway
 * stream) and how many tool steps it took. Replies have no tool-step limit;
 * this is what shows whether the loop detector is tuned right on real runs.
 * Counts and ids only; nothing a user or a tool wrote is ever recorded.
 *
 * Records from older builds may carry a `maxSteps` field (ignored) and a
 * `step_limit` stop, which is counted under `other`.
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { ReplyRecord, ReplyStats, ReplyStop } from '@nekko-agent/shared';
import { dataDir } from './store.js';

const LOG = () => join(dataDir(), 'replies.jsonl');
/** Loop stops kept for the "recent" list. */
const RECENT = 10;

export function recordReply(rec: ReplyRecord): void {
  try {
    appendFileSync(LOG(), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

export function clearReplies(): void {
  if (existsSync(LOG())) rmSync(LOG());
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const KNOWN_STOPS = new Set<string>(['complete', 'loop', 'runaway'] satisfies ReplyStop[]);

/** Fold the log into stats. Exported pure for the tests. */
export function summarizeReplies(records: ReplyRecord[]): ReplyStats | undefined {
  if (!records.length) return undefined;
  const byStop: ReplyStats['byStop'] = { complete: 0, loop: 0, runaway: 0, other: 0 };
  const toolSteps: number[] = [];
  const stops: ReplyStats['recentStops'] = [];
  for (const r of records) {
    const stop: ReplyStop | 'other' = KNOWN_STOPS.has(r.stop) ? r.stop : 'other';
    byStop[stop]++;
    if (r.steps > 0) toolSteps.push(r.steps);
    if (r.stop === 'loop') {
      stops.push({ ts: r.ts, sessionId: r.sessionId, modelId: r.modelId, steps: r.steps, stop: r.stop });
    }
  }
  toolSteps.sort((a, b) => a - b);
  return {
    total: records.length,
    byStop,
    p50Steps: percentile(toolSteps, 50),
    p90Steps: percentile(toolSteps, 90),
    mostSteps: toolSteps.at(-1) ?? 0,
    recentStops: stops.sort((a, b) => b.ts - a.ts).slice(0, RECENT),
  };
}

export function replyStats(): ReplyStats | undefined {
  if (!existsSync(LOG())) return undefined;
  const records: ReplyRecord[] = [];
  for (const line of readFileSync(LOG(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return summarizeReplies(records);
}
