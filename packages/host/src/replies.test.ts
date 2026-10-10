import { describe, expect, it } from 'vitest';
import type { ReplyRecord } from '@nekko-agent/shared';
import { summarizeReplies } from './replies.js';

const rec = (steps: number, stop: ReplyRecord['stop'], ts = steps): ReplyRecord => ({
  ts, sessionId: `s${ts}`, providerId: 'p', modelId: 'm', steps, stop,
});

/** A record written by a build that still had a tool-step limit. */
const legacy = (steps: number, ts: number) =>
  ({ ...rec(steps, 'complete', ts), stop: 'step_limit', maxSteps: 250 }) as unknown as ReplyRecord;

describe('summarizeReplies', () => {
  it('is undefined with nothing logged', () => {
    expect(summarizeReplies([])).toBeUndefined();
  });

  it('counts endings and step percentiles over tool-using replies', () => {
    const s = summarizeReplies([
      rec(0, 'complete', 1), rec(2, 'complete', 2), rec(4, 'complete', 3), rec(10, 'complete', 4),
      rec(6, 'loop', 5), rec(1500, 'complete', 6), rec(0, 'runaway', 7),
    ])!;
    expect(s.total).toBe(7);
    expect(s.byStop).toEqual({ complete: 5, loop: 1, runaway: 1, other: 0 });
    // Tool-using replies: 2, 4, 6, 10, 1500.
    expect(s.p50Steps).toBe(6);
    expect(s.p90Steps).toBe(1500);
    expect(s.mostSteps).toBe(1500);
  });

  it('lists loop stops, newest first', () => {
    const s = summarizeReplies([rec(6, 'loop', 1), rec(3, 'complete', 2), rec(9, 'loop', 3)])!;
    expect(s.recentStops.map((r) => r.ts)).toEqual([3, 1]);
    expect(s.recentStops[0]).not.toHaveProperty('maxSteps');
  });

  it('reads records from builds that had a step limit without surfacing it', () => {
    const s = summarizeReplies([legacy(250, 1), rec(3, 'complete', 2)])!;
    expect(s.total).toBe(2);
    expect(s.byStop).toEqual({ complete: 1, loop: 0, runaway: 0, other: 1 });
    expect(s.recentStops).toEqual([]);
    expect(s.mostSteps).toBe(250);
  });
});
