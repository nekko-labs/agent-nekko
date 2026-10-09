/** Local quota observations, deliberately separate from credentials and content. */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubscriptionLimits } from '@agent-nekko/shared';
import { dataDir } from './paths.js';
import { getSettings } from './store.js';

/** Append only explicitly selected quota fields. Unknown providers are not recorded. */
export function recordQuotaHistory(tokenKey: string, source: 'poll' | 'headers', limits: SubscriptionLimits): void {
  try {
    const provider = getSettings().providers.find((p) => p.tokenKey === tokenKey)
      ?? getSettings().providers.find((p) => tokenKey === `provider:${p.id}` && p.enabled);
    if (!provider) return;
    const record = {
      timestamp: limits.updatedAt,
      providerId: provider.id,
      source,
      windows: limits.windows.map((window) => ({
        id: window.id,
        scope: window.scope,
        usedPercent: window.usedPercent,
        resetsAt: window.resetAt,
        status: window.status,
      })),
    };
    appendFileSync(join(dataDir(), 'quota-history.jsonl'), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch {
    // History must never interrupt a limits read or a chat response.
  }
}
