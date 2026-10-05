import { appendFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import type { UsageRecord, UsageSummary } from '@agent-nekko/shared';
import { estimateCost, estimateCostUSD, isLocalProvider } from '@agent-nekko/shared';
import { getSettings } from './store.js';
import { dataDir } from './store.js';
import { clearReplies, replyStats } from './replies.js';

const LOG = () => join(dataDir(), 'usage.jsonl');

/** Delete the usage analytics log. */
export function clearUsage(): void {
  if (existsSync(LOG())) rmSync(LOG());
  clearReplies();
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
  const settings = getSettings();
  summary.avoidedCosts = { subscription: 0, local: 0, unpricedTokens: 0, benchmarkTokens: 0 };
  summary.bySessionAvoidedCosts = {};
  const replies = replyStats();
  if (replies) summary.replies = replies;
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
    const provider = settings.providers.find((p) => p.id === r.providerId);
    const local = r.local ?? (provider ? isLocalProvider(provider.kind) : false);
    const listCost = estimateCostUSD(r.modelId, r.inputTokens, r.outputTokens);
    const cost = local || r.auth === 'subscription' ? 0 : listCost;
    if (local || r.auth === 'subscription') {
      const tokens = { inputTokens: r.inputTokens, outputTokens: r.outputTokens };
      const exact = estimateCost(r.modelId, tokens);
      const benchmark = local && exact == null ? estimateCost(settings.localCostBenchmark, tokens) : undefined;
      const equivalent = exact ?? benchmark;
      const buckets = [summary.avoidedCosts];
      if (r.sessionId) buckets.push(summary.bySessionAvoidedCosts[r.sessionId] ??= { subscription: 0, local: 0, unpricedTokens: 0, benchmarkTokens: 0 });
      for (const bucket of buckets) {
        if (equivalent == null) bucket.unpricedTokens += r.inputTokens + r.outputTokens;
        else bucket[local ? 'local' : 'subscription'] += equivalent;
        if (benchmark != null) bucket.benchmarkTokens += r.inputTokens + r.outputTokens;
      }
    }
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
      bs.listCost = (bs.listCost ?? 0) + listCost;
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
