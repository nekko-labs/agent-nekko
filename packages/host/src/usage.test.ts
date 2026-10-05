import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUSD } from '@agent-nekko/shared';
import { withDataDir, setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import { recordUsage, usageSummary } from './usage.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function setup() {
  root = mkdtempSync(join(tmpdir(), 'nekko-savings-'));
  setDataDir(root);
  saveSettings({ providers: [], localCostBenchmark: 'claude-sonnet' });
}
function record(modelId: string, extra = {}) {
  recordUsage({ ts: Date.now(), providerId: 'p', sessionId: 's', modelId, inputTokens: 1_000_000, outputTokens: 1_000_000, ...extra });
}

it('keeps API spend, subscription avoidance and local avoidance separate', () => {
  setup();
  record('claude-opus', { auth: 'subscription' });
  record('llama3', { local: true });
  record('gpt-4o');
  const summary = usageSummary();
  expect(summary.totalCost).toBe(12.5);
  expect(summary.avoidedCosts).toEqual({ subscription: 30, local: 18, benchmarkTokens: 2_000_000, unpricedTokens: 0 });
  expect(summary.bySessionAvoidedCosts?.s).toEqual(summary.avoidedCosts);
});

it('prefers exact model prices, excludes unknown subscription prices, and reprices benchmarks', () => {
  setup();
  record('claude-haiku', { local: true });
  record('llama3', { local: true });
  record('unknown-subscription', { auth: 'subscription' });
  saveSettings({ localCostBenchmark: 'gpt-4o-mini' });
  expect(usageSummary().avoidedCosts).toEqual({ subscription: 0, local: 6.75, benchmarkTokens: 2_000_000, unpricedTokens: 2_000_000 });
  saveSettings({ localCostBenchmark: '' });
  expect(usageSummary().avoidedCosts?.unpricedTokens).toBe(4_000_000);
});

it('infers locality for old records but respects recorded locality after provider changes', () => {
  setup();
  saveSettings({ providers: [{ id: 'p', name: 'Local', kind: 'ollama', baseUrl: 'http://localhost:11434' }] });
  record('llama3');
  record('gpt-4o', { local: false });
  expect(usageSummary().totalCost).toBe(12.5);
  expect(usageSummary().avoidedCosts?.local).toBe(18);
});

describe('usageSummary', () => {
  it('prices subscription usage at list prices per session without billing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-usage-'));
    try {
      withDataDir(dir, () => {
        const model = 'claude-sonnet-4-5';
        recordUsage({ ts: 1, providerId: 'p', modelId: model, inputTokens: 1_000_000, outputTokens: 100_000, sessionId: 's', auth: 'subscription' });
        recordUsage({ ts: 2, providerId: 'q', modelId: model, inputTokens: 1_000, outputTokens: 1_000, sessionId: 's' });
        const s = usageSummary().bySession.s;
        const sub = estimateCostUSD(model, 1_000_000, 100_000);
        const metered = estimateCostUSD(model, 1_000, 1_000);
        expect(sub).toBeGreaterThan(0);
        expect(s.cost).toBeCloseTo(metered);
        expect(s.listCost).toBeCloseTo(sub + metered);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
