import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { UsageRecord, UsageSummary } from '@agent-nekko/shared';
import { estimateCostUSD } from '@agent-nekko/shared';
import { dataDir } from './store.js';

const LOG = () => join(dataDir(), 'usage.jsonl');

/** Delete the usage analytics log. */
export function clearUsage(): void {
  if (existsSync(LOG())) rmSync(LOG());
}

export function recordUsage(rec: UsageRecord): void {
  try {
    appendFileSync(LOG(), JSON.stringify(rec) + '\n', 'utf8');
  } catch {
    /* non-fatal */
  }
}

export function usageSummary(): UsageSummary {
  const summary: UsageSummary = { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, byProvider: {}, bySession: {}, bySessionCost: {}, daily: [] };
  if (!existsSync(LOG())) return summary;

  const dailyMap = new Map<string, { input: number; output: number; cost: number }>();
  for (const line of readFileSync(LOG(), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: UsageRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    // Subscription providers charge through the user's plan, not per API token.
    const cost = r.auth === 'subscription' ? 0 : estimateCostUSD(r.modelId, r.inputTokens, r.outputTokens);
    summary.totalInput += r.inputTokens;
    summary.totalOutput += r.outputTokens;
    summary.totalCost += cost;

    const bm = (summary.byModel[r.modelId] ??= { input: 0, output: 0 });
    bm.input += r.inputTokens;
    bm.output += r.outputTokens;
    bm.cost = (bm.cost ?? 0) + cost;
    if (r.auth === 'subscription') bm.subscription = true;

    const bp = (summary.byProvider[r.providerId] ??= { input: 0, output: 0 });
    bp.input += r.inputTokens;
    bp.output += r.outputTokens;

    if (r.sessionId) {
      const bs = (summary.bySession[r.sessionId] ??= { input: 0, output: 0 });
      bs.input += r.inputTokens;
      bs.output += r.outputTokens;
      bs.cost = (bs.cost ?? 0) + cost;
      summary.bySessionCost[r.sessionId] = (summary.bySessionCost[r.sessionId] ?? 0) + cost;
    }

    if (r.auth === 'subscription') summary.hasSubscriptionUsage = true;

    const day = new Date(r.ts).toISOString().slice(0, 10);
    const d = dailyMap.get(day) ?? { input: 0, output: 0, cost: 0 };
    d.input += r.inputTokens;
    d.output += r.outputTokens;
    d.cost += cost;
    dailyMap.set(day, d);
  }

  summary.daily = [...dailyMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return summary;
}
