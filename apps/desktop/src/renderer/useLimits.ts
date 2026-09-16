import { useEffect, useState } from 'react';
import type { ProviderConfig, SubscriptionLimits } from '@agent-nekko/shared';

/**
 * Live subscription limits for one provider, or null when it doesn't have any
 * (an API key, a local server, or a provider that isn't signed in).
 *
 * Read in several places at once — the composer's model picker, the Auto-mode
 * pick, the workbench sidebar — so it loads once and then follows the host's
 * `limitsUpdated` events rather than each caller polling on its own.
 */
export function useProviderLimits(provider: ProviderConfig | undefined): SubscriptionLimits | null {
  const [limits, setLimits] = useState<SubscriptionLimits | null>(null);
  const tokenKey = provider?.tokenKey;

  useEffect(() => {
    if (!tokenKey) {
      setLimits(null);
      return;
    }
    let live = true;
    window.nekko.getLimits(tokenKey).then((l) => { if (live) setLimits(l ?? null); }).catch(() => {});
    const off = window.nekko.onLimitsUpdated((e) => {
      if (e.tokenKey === tokenKey) setLimits(e.limits);
    });
    return () => { live = false; off(); };
  }, [tokenKey]);

  return limits;
}

/**
 * Limits for several providers at once, keyed by token key. Used by the model
 * picker, whose list spans every configured provider rather than just the one
 * this chat is on.
 */
export function useAllProviderLimits(
  providers: ProviderConfig[],
  enabled = true,
): Record<string, SubscriptionLimits> {
  const [byToken, setByToken] = useState<Record<string, SubscriptionLimits>>({});
  // Token keys, as a stable string, so re-rendering with a new array identity
  // doesn't re-fetch every provider's usage.
  const keys = providers.filter((p) => p.auth === 'subscription' && p.tokenKey).map((p) => p.tokenKey!);
  const keysId = keys.join('|');

  useEffect(() => {
    if (!enabled || keys.length === 0) return;
    let live = true;
    Promise.all(
      keys.map((k) => window.nekko.getLimits(k).then((l) => [k, l] as const).catch(() => [k, null] as const)),
    ).then((entries) => {
      if (!live) return;
      const next: Record<string, SubscriptionLimits> = {};
      for (const [k, l] of entries) if (l) next[k] = l;
      setByToken(next);
    });
    const off = window.nekko.onLimitsUpdated((e) => {
      if (keys.includes(e.tokenKey)) setByToken((prev) => ({ ...prev, [e.tokenKey]: e.limits }));
    });
    return () => { live = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, keysId]);

  return byToken;
}
