import { expect, it } from 'vitest';
import type { UsageSummary, SessionSummary, ProviderConfig } from '@agent-nekko/shared';
import { recordedBudgetMetrics } from './wallDockMetrics.js';
it('reports unavailable rather than zero when the usage snapshot is missing', () => {
  expect(recordedBudgetMetrics(null, [], [])).toEqual({ topAgent: 'Unavailable', localTokens: 'Unavailable' });
});
it('ranks recorded session tokens and counts only local provider totals', () => {
  const usage = { bySession: { a: { input: 5, output: 7 }, b: { input: 20, output: 10 } }, byProvider: { local: { input: 9, output: 11 }, cloud: { input: 100, output: 200 } } } as unknown as UsageSummary;
  const sessions = [{ id: 'b', title: 'Build UI' }] as SessionSummary[];
  const providers = [{ id: 'local', kind: 'ollama' }, { id: 'cloud', kind: 'openai' }] as ProviderConfig[];
  expect(recordedBudgetMetrics(usage, sessions, providers)).toEqual({ topAgent: 'Build UI · 30 tokens', localTokens: '20' });
});
