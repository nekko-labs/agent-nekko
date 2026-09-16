import { describe, expect, it } from 'vitest';
import type { ModelInfo } from './models.js';
import type { SubscriptionLimits } from './limits.js';
import { blockLabel, formatResetIn, resolveModelAvailability, windowCoversModel } from './model-availability.js';

const NOW = 1_700_000_000_000;

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  providerId: 'claude',
  name: id,
  ...extra,
});

const limits = (windows: SubscriptionLimits['windows']): SubscriptionLimits => ({
  windows,
  updatedAt: NOW,
  staleAfterMs: 35_000,
});

describe('windowCoversModel', () => {
  it('matches a model-scoped window by family, across generations', () => {
    const w = { scope: 'model' as const, modelFamily: 'opus' };
    expect(windowCoversModel(w, 'claude-opus-5')).toBe(true);
    expect(windowCoversModel(w, 'claude-opus-4-8')).toBe(true);
    expect(windowCoversModel(w, 'claude-sonnet-5')).toBe(false);
  });

  it('treats account-wide windows as covering every model', () => {
    expect(windowCoversModel({ scope: 'weekly' }, 'gpt-4.1')).toBe(true);
    expect(windowCoversModel({ scope: 'session' }, 'anything')).toBe(true);
  });
});

describe('resolveModelAvailability', () => {
  it('reads as ready when nothing says otherwise', () => {
    expect(resolveModelAvailability({ model: model('claude-opus-5') })).toEqual({ status: 'ready' });
  });

  it('blocks only the family a model-scoped window covers', () => {
    const l = limits([
      { id: '7d_opus', label: '7-day Opus', scope: 'model', modelFamily: 'opus', usedPercent: 100, resetAt: NOW + 2 * 86_400_000, status: 'rate_limited' },
    ]);
    const opus = resolveModelAvailability({ model: model('claude-opus-5'), limits: l });
    expect(opus.status).toBe('blocked');
    expect(opus.reason).toBe('rate-limited');
    expect(opus.resetAt).toBe(NOW + 2 * 86_400_000);
    expect(resolveModelAvailability({ model: model('claude-sonnet-5'), limits: l }).status).toBe('ready');
  });

  it('blocks every model when an account-wide window is spent', () => {
    const l = limits([
      { id: '7d', label: '7-day', scope: 'weekly', usedPercent: 100, resetAt: NOW, status: 'rate_limited' },
    ]);
    for (const id of ['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'gpt-4.1']) {
      expect(resolveModelAvailability({ model: model(id), limits: l }).reason).toBe('rate-limited');
    }
  });

  it('ignores windows that are merely warm', () => {
    const l = limits([
      { id: '7d', label: '7-day', scope: 'weekly', usedPercent: 92, resetAt: NOW, status: 'warning' },
    ]);
    expect(resolveModelAvailability({ model: model('claude-opus-5'), limits: l }).status).toBe('ready');
  });

  it('keeps the catalog reason when no window is spent', () => {
    const m = model('claude-fable-5-1', {
      availability: { status: 'blocked', reason: 'plan', detail: 'Needs a Max plan.' },
    });
    expect(resolveModelAvailability({ model: m })).toMatchObject({ reason: 'plan', detail: 'Needs a Max plan.' });
  });

  it('lets a live rate limit override the catalog reason', () => {
    const m = model('claude-opus-5', { availability: { status: 'blocked', reason: 'plan' } });
    const l = limits([
      { id: '7d_opus', label: '7-day Opus', scope: 'model', modelFamily: 'opus', usedPercent: 100, resetAt: NOW, status: 'rate_limited' },
    ]);
    expect(resolveModelAvailability({ model: m, limits: l }).reason).toBe('rate-limited');
  });

  it('says so when a subscription provider has no token', () => {
    const a = resolveModelAvailability({ model: model('claude-opus-5'), provider: { auth: 'subscription' } });
    expect(a).toMatchObject({ status: 'blocked', reason: 'signed-out' });
  });
});

describe('labels', () => {
  it('names each block reason', () => {
    expect(blockLabel({ status: 'blocked', reason: 'rate-limited' })).toBe('Limit reached');
    expect(blockLabel({ status: 'blocked', reason: 'plan' })).toBe('Not in your plan');
    expect(blockLabel({ status: 'blocked' })).toBe('Unavailable');
  });

  it('formats a reset time in the largest useful unit', () => {
    expect(formatResetIn(NOW + 30 * 60_000, NOW)).toBe('in 30m');
    expect(formatResetIn(NOW + 5 * 3_600_000, NOW)).toBe('in 5h');
    expect(formatResetIn(NOW + 2 * 86_400_000, NOW)).toBe('in 2d');
    expect(formatResetIn(NOW - 1, NOW)).toBe('soon');
    expect(formatResetIn(0, NOW)).toBeUndefined();
  });
});
