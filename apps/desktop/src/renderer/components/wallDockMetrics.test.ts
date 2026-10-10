import { expect, it } from 'vitest';
import type { UsageSummary, SessionSummary, ProviderConfig } from '@agent-nekko/shared';
import { budgetRange, recordedBudgetMetrics } from './wallDockMetrics.js';
it('reports unavailable rather than zero when the usage snapshot is missing', () => {
  expect(recordedBudgetMetrics(null, [], [])).toEqual({ topAgent: 'Unavailable', localTokens: 'Unavailable' });
});
it('ranks recorded session tokens and counts only local provider totals', () => {
  const usage = { bySession: { a: { input: 5, output: 7 }, b: { input: 20, output: 10 } }, byProvider: { local: { input: 9, output: 11 }, cloud: { input: 100, output: 200 } } } as unknown as UsageSummary;
  const sessions = [{ id: 'b', title: 'Build UI' }] as SessionSummary[];
  const providers = [{ id: 'local', kind: 'ollama' }, { id: 'cloud', kind: 'openai' }] as ProviderConfig[];
  expect(recordedBudgetMetrics(usage, sessions, providers)).toEqual({ topAgent: 'Build UI · 30 tokens', localTokens: '20' });
});
it('sums Budget spend and tokens over the chosen Insights range', () => {
  const usage = { daily: [
    { date: '2026-10-08', input: 1, output: 2, cost: 0.5 },
    { date: '2026-10-03', input: 10, output: 20, cost: 1 },
    { date: '2026-01-01', input: 100, output: 200, cost: 5 },
  ] } as unknown as UsageSummary;
  const now = new Date('2026-10-08T09:00:00Z');
  expect(budgetRange(null, '1m', now)).toBeNull();
  expect(budgetRange(usage, 'today', now)).toMatchObject({ spend: 0.5, input: 1, output: 2 });
  expect(budgetRange(usage, '1wk', now)).toMatchObject({ spend: 1.5, input: 11, output: 22 });
  expect(budgetRange(usage, 'all-time', now)).toMatchObject({ spend: 6.5, input: 111, output: 222 });
});

