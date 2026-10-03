import { describe, expect, it } from 'vitest';
import type { ReplyRecord } from '@agent-nekko/shared';
import { summarizeReplies } from './replies.js';

const rec = (steps: number, stop: ReplyRecord['stop'], ts = steps): ReplyRecord => ({
  ts, sessionId: `s${ts}`, providerId: 'p', modelId: 'm', steps, stop, maxSteps: 250,
});

describe('summarizeReplies', () => {
  it('is undefined with nothing logged', () => {
    expect(summarizeReplies([])).toBeUndefined();
  });

  it('counts endings and step percentiles over tool-using replies', () => {
    const s = summarizeReplies([
      rec(0, 'complete', 1), rec(2, 'complete', 2), rec(4, 'complete', 3), rec(10, 'complete', 4),
      rec(6, 'loop', 5), rec(250, 'step_limit', 6), rec(0, 'runaway', 7),
    ])!;
    expect(s.total).toBe(7);
    expect(s.byStop).toEqual({ complete: 4, step_limit: 1, loop: 1, runaway: 1 });
    // Tool-using replies: 2, 4, 6, 10, 250.
    expect(s.p50Steps).toBe(6);
    expect(s.p90Steps).toBe(250);
    expect(s.maxSteps).toBe(250);
  });

  it('lists budget and loop stops, newest first', () => {
    const s = summarizeReplies([rec(250, 'step_limit', 1), rec(3, 'complete', 2), rec(6, 'loop', 3)])!;
    expect(s.recentStops.map((r) => r.stop)).toEqual(['loop', 'step_limit']);
  });
});
