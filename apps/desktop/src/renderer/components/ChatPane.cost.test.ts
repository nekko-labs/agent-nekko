import { describe, expect, it } from 'vitest';
import { measuredUsageCost } from './ChatPane.cost.js';

describe('ChatPane measured usage cost', () => {
  it.each([
    { counters: { cacheReadTokens: 1_000_000 }, cost: 0.30 },
    { counters: { cacheWriteTokens: 1_000_000 }, cost: 3.75 },
    { counters: { cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 }, cost: 4.05 },
  ])('prices cache-only usage $counters', ({ counters, cost }) => {
    expect(measuredUsageCost('claude-sonnet-4', {
      type: 'usage', sessionId: 's', inputTokens: 0, outputTokens: 0, ...counters,
    })).toBeCloseTo(cost);
  });

  it('adds non-cached counts without double-counting cached tokens', () => {
    expect(measuredUsageCost('claude-sonnet-4', {
      type: 'usage', sessionId: 's', inputTokens: 1_000_000, outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000,
    })).toBeCloseTo(22.05);
  });

  it('preserves zero fallback for unpriced models', () => {
    expect(measuredUsageCost(undefined, { type: 'usage', sessionId: 's', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 })).toBe(0);
  });
});
