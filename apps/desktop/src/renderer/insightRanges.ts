import type { UsageSummary } from '@agent-nekko/shared';

export const INSIGHT_RANGES = ['today', '1wk', '1m', '6m', '1y', 'all-time'] as const;
export type InsightRange = typeof INSIGHT_RANGES[number];

/** Inclusive UTC day windows, matching the usage summary's UTC date keys. */
export function insightDays(daily: UsageSummary['daily'], range: InsightRange, now = new Date()): UsageSummary['daily'] {
  const end = now.toISOString().slice(0, 10);
  if (range === 'all-time') return daily.filter((d) => d.date <= end);
  const days = { today: 1, '1wk': 7, '1m': 30, '6m': 180, '1y': 365 }[range];
  const start = new Date(`${end}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const startKey = start.toISOString().slice(0, 10);
  return daily.filter((d) => d.date >= startKey && d.date <= end);
}
