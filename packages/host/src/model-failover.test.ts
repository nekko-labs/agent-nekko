import { describe, expect, it } from 'vitest';
import type { ProviderConfig, ProviderPool, Session, SubscriptionLimits } from '@nekko-agent/shared';
import { eligibleForModelFailover, exhaustedSubscription, selectModelFailover } from './model-failover.js';

const session = { autoModel: true, autoProviderSwitch: true } as Session;
const providers: ProviderConfig[] = ['a', 'b'].map((id) => ({ id, kind: 'openai', label: id, baseUrl: 'https://example.test', enabled: true }));
const pools: ProviderPool[] = providers.map((p) => ({ providerId: p.id, providerLabel: p.label, models: [{ id: 'gpt-5', name: 'GPT-5', providerId: p.id }] }));
const limits: SubscriptionLimits = { updatedAt: 100, staleAfterMs: 1000, windows: [{ id: 'w', label: 'weekly', scope: 'model', modelFamily: 'opus', usedPercent: 100, resetAt: 2000, status: 'rate_limited' }] };
const select = (patch = {}) => selectModelFailover({ session, providers, pools, currentProviderId: 'a', currentModelId: 'gpt-5', attemptedProviderIds: new Set<string>(), prompt: 'implement', now: 500, ...patch });

describe('CP6 failover policy foundation', () => {
  it('is default-off, Auto-only, and excludes delegation children', () => {
    expect(eligibleForModelFailover({})).toBe(false);
    expect(eligibleForModelFailover({ autoProviderSwitch: true })).toBe(false);
    expect(eligibleForModelFailover({ ...session, parentSessionId: 'parent' })).toBe(false);
    expect(eligibleForModelFailover(session)).toBe(true);
  });
  it('requires fresh, covering, exhausted windows with a future reset', () => {
    expect(exhaustedSubscription(limits, 'claude-opus', 500)).toBe(true);
    expect(exhaustedSubscription(limits, 'claude-sonnet', 500)).toBe(false);
    expect(exhaustedSubscription(limits, 'claude-opus', 1100)).toBe(false);
    expect(exhaustedSubscription({ ...limits, updatedAt: 2000 }, 'claude-opus', 2100)).toBe(false);
    expect(exhaustedSubscription({ ...limits, windows: [{ ...limits.windows[0], status: 'allowed', usedPercent: 95 }] }, 'claude-opus', 500)).toBe(false);
  });
  it('intersects supplied pools with enabled config and excludes attempted providers', () => {
    expect(select()).toEqual({ providerId: 'b', modelId: 'gpt-5' });
    expect(select({ providers: [providers[0], { ...providers[1], enabled: false }] })).toBeNull();
    expect(select({ attemptedProviderIds: new Set(['b']) })).toBeNull();
    expect(select({ pools: [pools[0]] })).toBeNull();
    expect(select({ pools: [pools[0], { ...pools[1], models: [{ id: 'gpt-5', name: 'GPT-5', providerId: 'other' }] }] })).toBeNull();
  });
  it('never moves offline or local work to cloud, and never downgrades', () => {
    expect(select({ session: { ...session, offline: true } })).toBeNull();
    expect(select({ providers: [{ ...providers[0], kind: 'ollama', baseUrl: 'http://localhost:11434' }, providers[1]] })).toBeNull();
    expect(select({ pools: [pools[0], { ...pools[1], models: [{ id: 'haiku', name: 'Haiku', providerId: 'b' }] }] })).toBeNull();
    expect(select({ session: { ...session, offline: true }, providers: providers.map((p) => ({ ...p, kind: 'openai-compat', baseUrl: 'http://127.0.0.1:1234' })) })).toEqual({ providerId: 'b', modelId: 'gpt-5' });
  });
});
