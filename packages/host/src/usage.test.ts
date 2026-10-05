import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { estimateCostUSD } from '@agent-nekko/shared';
import { withDataDir } from './paths.js';
import { recordUsage, usageSummary } from './usage.js';

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
