import { describe, expect, it } from 'vitest';
import { insightDays, INSIGHT_RANGES } from './insightRanges.js';

const now = new Date('2026-03-01T12:00:00Z');
const daily = Array.from({ length: 401 }, (_, i) => {
  const day = new Date('2026-03-02T00:00:00Z');
  day.setUTCDate(day.getUTCDate() - i);
  return { date: day.toISOString().slice(0, 10), input: 10, output: 5, cost: 1 };
}).reverse();

describe('insightDays', () => {
  it.each(INSIGHT_RANGES)('selects inclusive UTC days for %s and excludes future data', (range) => {
    const expected = { today: 1, '1wk': 7, '1m': 30, '6m': 180, '1y': 365, 'all-time': 400 }[range];
    const selected = insightDays(daily, range, now);
    expect(selected).toHaveLength(expected);
    expect(selected.at(-1)?.date).toBe('2026-03-01');
    expect(selected.reduce((sum, d) => sum + d.input, 0)).toBe(expected * 10);
  });
  it('does not substitute old recorded days for an empty range', () => {
    expect(insightDays(daily.slice(0, 1), 'today', now)).toEqual([]);
  });
  it('handles empty history', () => {
    expect(insightDays([], 'all-time', now)).toEqual([]);
  });
});
