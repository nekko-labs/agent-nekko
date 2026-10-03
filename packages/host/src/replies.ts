/**
 * The reply log: how each agent reply ended (finished, step budget, loop
 * detector, runaway stream) and how many tool steps it took.
 *
 * This is the observation half of tuning the step budget: a fixed limit was hit
 * on real coding turns, and the right default is a question for data, not
 * taste. Counts and ids only; nothing a user or a tool wrote is ever recorded.
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { ReplyRecord, ReplyStats, ReplyStop } from '@agent-nekko/shared';
import { dataDir } from './store.js';

const LOG = () => join(dataDir(), 'replies.jsonl');
/** Limit and loop stops kept for the "recent" list. */
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

/** Fold the log into stats. Exported pure for the tests. */
export function summarizeReplies(records: ReplyRecord[]): ReplyStats | undefined {
  if (!records.length) return undefined;
  const byStop: Record<ReplyStop, number> = { complete: 0, step_limit: 0, loop: 0, runaway: 0 };
  const toolSteps: number[] = [];
  const stops: ReplyStats['recentStops'] = [];
  for (const r of records) {
    byStop[r.stop] = (byStop[r.stop] ?? 0) + 1;
    if (r.steps > 0) toolSteps.push(r.steps);
    if (r.stop === 'step_limit' || r.stop === 'loop') {
      stops.push({ ts: r.ts, sessionId: r.sessionId, modelId: r.modelId, steps: r.steps, stop: r.stop, maxSteps: r.maxSteps });
    }
  }
  toolSteps.sort((a, b) => a - b);
  return {
    total: records.length,
    byStop,
    p50Steps: percentile(toolSteps, 50),
    p90Steps: percentile(toolSteps, 90),
    maxSteps: toolSteps.at(-1) ?? 0,
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
