import React, { useEffect, useState } from 'react';
import type { LimitWindow, ProviderConfig, SubscriptionLimits } from '@agent-nekko/shared';
import { formatUSD, isLocalProvider } from '@agent-nekko/shared';

/** Relative time from now to a future timestamp, in compact words. */
function timeUntil(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

function relTime(ms: number): string {
  if (ms < 1000) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Chat-header usage chip:
 * - subscription providers: the binding (highest-utilization) window percent + reset countdown
 * - metered providers: the running session cost
 * - local models: Free
 *
 * Hover/focus opens a popover with every window, reset time, plan type and credits.
 */
export function UsageLimitsChip({
  provider,
  session,
  cost = 0,
}: {
  provider?: ProviderConfig;
  session?: { id?: string } | null;
  cost?: number;
}) {
  const [limits, setLimits] = useState<SubscriptionLimits | null>(null);
  const [now, setNow] = useState(Date.now());

  // Refresh the countdowns every 30 seconds.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Load + subscribe to limits for this provider's token key.
  useEffect(() => {
    const tokenKey = provider?.tokenKey;
    if (!tokenKey) {
      setLimits(null);
      return;
    }
    let live = true;
    window.kotrain.getLimits(tokenKey).then((l) => { if (live) setLimits(l ?? null); }).catch(() => {});
    const off = window.kotrain.onLimitsUpdated((e) => {
      if (e.tokenKey === tokenKey) setLimits(e.limits);
    });
    return () => { live = false; off(); };
  }, [provider?.tokenKey]);

  if (!provider) return null;

  const local = isLocalProvider(provider.kind);
  const subscription = provider.auth === 'subscription';

  // Binding window: the highest-utilization window is what the user is most likely to hit next.
  const windows = limits?.windows ?? [];
  const binding = windows.length
    ? [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
    : undefined;

  const stale = limits && now > limits.updatedAt + limits.staleAfterMs;

  const chipText = () => {
    if (local) return 'Free';
    if (subscription) {
      if (!provider.tokenKey) return 'Subscription · sign in';
      if (!limits) return 'Limits · …';
      if (!binding) return 'Limits · no data';
      return `Limits ${Math.round(binding.usedPercent)}%`;
    }
    return formatUSD(cost);
  };

  const chipColor = () => {
    if (local) return 'var(--success)';
    if (subscription && binding) {
      if (binding.status === 'rate_limited') return 'var(--danger)';
      if (binding.status === 'warning') return 'var(--warning)';
    }
    return undefined;
  };

  const chipTitle = () => {
    if (local) return 'Local models run on this machine and cost nothing';
    if (subscription) {
      if (!provider.tokenKey) return 'Sign in to see subscription limits';
      if (!binding) return 'Waiting for the first usage response';
      return `${binding.label} window is ${Math.round(binding.usedPercent)}% used · resets ${timeUntil(binding.resetAt - now)}`;
    }
    return `Estimated session cost at published list prices; your bill may differ`;
  };

  const windowOrder: LimitWindow['scope'][] = ['session', 'weekly', 'model'];
  const sortedWindows = [...windows].sort(
    (a, b) => windowOrder.indexOf(a.scope) - windowOrder.indexOf(b.scope) || b.usedPercent - a.usedPercent,
  );

  return (
    <div className="group relative shrink-0">
      <button
        type="button"
        className="chip max-w-[180px] cursor-default"
        tabIndex={0}
        title={chipTitle()}
        style={chipColor() ? { color: chipColor(), background: `color-mix(in srgb, ${chipColor()} 14%, var(--surface-2))` } : undefined}
      >
        {chipText()}
        {subscription && binding && (
          <span className="ml-1 text-[10px] tabular-nums text-ink-faint">
            {timeUntil(binding.resetAt - now)}
          </span>
        )}
      </button>

      {/* Hover/focus popover: every window, plus plan + credits. */}
      <div
        className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 hidden w-72 rounded-xl border border-line p-3 text-[11px] shadow-lg group-hover:block group-focus-within:block"
        style={{ background: 'var(--surface)' }}
        role="tooltip"
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-semibold text-ink">
            {subscription ? 'Subscription limits' : 'Session cost'}
          </span>
          {limits && (
            <span className="text-[10px] text-ink-faint" title={stale ? 'Snapshot is stale; a new read will retry on the next update' : undefined}>
              {stale ? 'stale · ' : ''}updated {relTime(now - limits.updatedAt)}
            </span>
          )}
        </div>

        {subscription ? (
          <>
            {sortedWindows.length === 0 ? (
              <p className="text-ink-faint">No limit windows reported yet. Send a message to refresh.</p>
            ) : (
              <div className="space-y-1.5">
                {sortedWindows.map((w) => {
                  const tone = w.status === 'rate_limited' ? 'danger' : w.status === 'warning' ? 'warning' : 'success';
                  const statusLabel = w.status === 'rate_limited' ? 'Limited' : w.status === 'warning' ? 'Warning' : 'OK';
                  return (
                    <div key={w.id} className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: `var(--${tone})` }}
                        title={statusLabel}
                      />
                      <span className="min-w-0 flex-1 truncate text-ink-soft">{w.label}</span>
                      <span className="shrink-0 tabular-nums font-medium">{Math.round(w.usedPercent)}%</span>
                      <span className="w-16 shrink-0 text-right tabular-nums text-ink-faint">
                        {w.resetAt > now ? timeUntil(w.resetAt - now) : 'resets soon'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2 text-[10px] text-ink-faint">
              <span>Plan: {limits?.planType ?? '—'}</span>
              <span>Credits: {limits?.creditsBalance === undefined ? 'Unlimited' : formatUSD(limits.creditsBalance)}</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline justify-between">
              <span className="text-ink-soft">This session</span>
              <span className="text-[13px] font-semibold tabular-nums">{formatUSD(cost)}</span>
            </div>
            <p className="mt-1.5 text-ink-faint">
              {local
                ? 'Local models run privately on this machine and cost nothing.'
                : 'Estimate from published list prices. Your provider bill may differ.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
