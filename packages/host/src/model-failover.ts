import type { ProviderConfig, ProviderPool, Session, SubscriptionLimits } from '@agent-nekko/shared';
import { isChatModel, isLocalProvider, modelTier, pickAutoModel, resolveModelAvailability, windowCoversModel } from '@agent-nekko/shared';

/** CP6 foundation only: callers must supply verified model lists, not guessed IDs.
 * No discovery, polling, credentials, or provider calls occur in this module.
 */
export function eligibleForModelFailover(session: Pick<Session, 'autoModel' | 'autoProviderSwitch' | 'parentSessionId'>): boolean {
  // Children are deliberately excluded, including explicitly routed delegation.
  return session.autoModel === true && session.autoProviderSwitch === true && !session.parentSessionId;
}

export function exhaustedSubscription(limits: SubscriptionLimits | undefined, modelId: string, now = Date.now()): boolean {
  if (!limits || limits.updatedAt + limits.staleAfterMs <= now) return false;
  return limits.windows.some((w) => windowCoversModel(w, modelId) &&
    (w.status === 'rate_limited' || w.usedPercent >= 100) &&
    Number.isFinite(w.resetAt) && w.resetAt > now);
}

function localEndpoint(p: ProviderConfig): boolean {
  try {
    const url = new URL(p.baseUrl);
    return (isLocalProvider(p.kind) || p.kind === 'openai-compat') &&
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      (url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname));
  } catch { return false; }
}

/** Select only from the supplied Auto pool intersected with current enabled config.
 * A local route is sticky: local failure never authorizes cloud egress.
 * Attempts are excluded by provider (not just model) to prevent provider cycling.
 */
export function selectModelFailover(input: {
  session: Session;
  providers: ProviderConfig[];
  pools: ProviderPool[];
  currentProviderId: string;
  currentModelId: string;
  attemptedProviderIds: ReadonlySet<string>;
  prompt: string;
  now?: number;
}): { providerId: string; modelId: string } | null {
  if (!eligibleForModelFailover(input.session)) return null;
  const current = input.providers.find((p) => p.id === input.currentProviderId);
  const homeModel = input.pools.find((p) => p.providerId === input.currentProviderId)?.models.find((m) => m.id === input.currentModelId);
  if (!current || !homeModel) return null;
  const localOnly = input.session.offline || isLocalProvider(current.kind) || localEndpoint(current);
  const now = input.now ?? Date.now();
  const candidates = input.pools.flatMap((pool) => {
    const config = input.providers.find((p) => p.id === pool.providerId);
    if (!config?.enabled || pool.providerId === current.id || input.attemptedProviderIds.has(pool.providerId)) return [];
    if (localOnly && !localEndpoint(config)) return [];
    const models = pool.models.filter((m) => m.providerId === config.id && isChatModel(m) &&
      modelTier(m) >= modelTier(homeModel) &&
      resolveModelAvailability({ model: m, provider: config, limits: pool.limits }).status === 'ready' &&
      !exhaustedSubscription(pool.limits ?? undefined, m.id, now));
    const pick = pickAutoModel(models, input.prompt, { quality: input.session.autoQuality });
    return pick ? [{ providerId: config.id, modelId: pick.modelId }] : [];
  });
  return candidates[0] ?? null;
}
