import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataDir } from './paths.js';
import { setToken } from './oauth.js';
import { initLimits, recordFromHeaders, poll, get, getLimits } from './limits.js';

const TEST_NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('LimitsService header capture', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kotrain-limits-'));
    setDataDir(dir);
  });

  it('emits a normalized snapshot from Anthropic response headers', () => {
    const events = new EventEmitter();
    const emitted: Array<{ tokenKey: string; limits: import('@agent-nekko/shared').SubscriptionLimits }> = [];
    events.on('limitsUpdated', (e) => emitted.push(e));
    initLimits(events);

    const headers = new Headers({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.35',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.12',
      'anthropic-ratelimit-unified-7d-reset': '1900000000',
      'anthropic-ratelimit-unified-7d-status': 'warning',
      'anthropic-ratelimit-unified-7d_sonnet-utilization': '0.05',
      'anthropic-ratelimit-unified-7d_sonnet-reset': '1850000000',
      'anthropic-ratelimit-unified-7d_sonnet-status': 'allowed',
      'anthropic-ratelimit-unified-7d_opus-utilization': '0.0',
      'anthropic-ratelimit-unified-7d_opus-reset': '0',
      'anthropic-ratelimit-unified-7d_opus-status': 'allowed',
    });

    const limits = recordFromHeaders('claude:acct-1', 'anthropic', headers);
    expect(limits).toBeTruthy();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tokenKey).toBe('claude:acct-1');

    const state = get('claude:acct-1');
    expect(state).toBeTruthy();
    expect(state!.windows).toHaveLength(4);

    const fiveHour = state!.windows.find((w) => w.id === '5h');
    expect(fiveHour).toMatchObject({
      id: '5h',
      scope: 'session',
      usedPercent: 35,
      resetAt: 1_800_000_000_000,
      status: 'allowed',
    });

    const sevenDay = state!.windows.find((w) => w.id === '7d');
    expect(sevenDay).toMatchObject({
      id: '7d',
      scope: 'weekly',
      usedPercent: 12,
      resetAt: 1_900_000_000_000,
      status: 'warning',
    });

    const sonnetWindow = state!.windows.find((w) => w.id === '7d_sonnet');
    expect(sonnetWindow).toMatchObject({
      id: '7d_sonnet',
      scope: 'model',
      modelId: 'claude-sonnet-4-6',
      usedPercent: 5,
    });
  });

  it('normalizes rate_limited and rejected statuses', () => {
    initLimits(new EventEmitter());
    const headers = new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '1.0',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'rate_limited',
      'anthropic-ratelimit-unified-7d-utilization': '1.0',
      'anthropic-ratelimit-unified-7d-reset': '1900000000',
      'anthropic-ratelimit-unified-7d-status': 'rejected',
    });
    const limits = recordFromHeaders('claude:acct-2', 'anthropic', headers)!;
    expect(limits.windows[0].status).toBe('rate_limited');
    expect(limits.windows[1].status).toBe('rate_limited');
  });

  it('leaves existing state unchanged when no recognized headers are present', () => {
    initLimits(new EventEmitter());
    const first = recordFromHeaders('claude:acct-3', 'anthropic', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));
    expect(first).toBeTruthy();

    const second = recordFromHeaders('claude:acct-3', 'anthropic', new Headers({ 'content-type': 'application/json' }));
    expect(second).toEqual(first);
    expect(get('claude:acct-3')).toEqual(first);
  });
});

describe('LimitsService ChatGPT /wham/usage poll', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kotrain-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('parses the verified ChatGPT payload shape', async () => {
    const tokenKey = 'chatgpt:acct-1';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'acct-1',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const payload = {
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 55, limit_window_seconds: 18000, reset_at: 1778670307 },
        secondary_window: { used_percent: 51, limit_window_seconds: 604800, reset_at: 1779157165 },
      },
      credits: { has_credits: false, unlimited: false, balance: '0' },
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer chatgpt-access');
    expect((init.headers as Record<string, string>)['ChatGPT-Account-Id']).toBe('acct-1');

    expect(limits).toBeTruthy();
    expect(limits!.planType).toBe('plus');
    expect(limits!.creditsBalance).toBe(0);
    expect(limits!.windows).toHaveLength(2);

    const primary = limits!.windows.find((w) => w.id === '5h');
    expect(primary).toMatchObject({
      id: '5h',
      scope: 'session',
      usedPercent: 55,
      resetAt: 1_778_670_307_000,
      status: 'allowed',
    });

    const secondary = limits!.windows.find((w) => w.id === '7d');
    expect(secondary).toMatchObject({
      id: '7d',
      scope: 'weekly',
      usedPercent: 51,
      resetAt: 1_779_157_165_000,
      status: 'allowed',
    });
  });

  it('throttles to one network call within 30 seconds', async () => {
    const tokenKey = 'chatgpt:acct-2';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'acct-2',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1778670307 },
          secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: 1779157165 },
        },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    await poll(tokenKey);
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(15_000);
    const second = await poll(tokenKey);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second).toBeTruthy();

    vi.advanceTimersByTime(20_000);
    await poll(tokenKey);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('emits limitsUpdated when a poll returns new state', async () => {
    const tokenKey = 'chatgpt:acct-3';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'acct-3',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1778670307 },
          secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: 1779157165 },
        },
        credits: { has_credits: false, unlimited: false, balance: '0' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const events = new EventEmitter();
    const emitted: Array<{ tokenKey: string; limits: import('@agent-nekko/shared').SubscriptionLimits }> = [];
    events.on('limitsUpdated', (e) => emitted.push(e));
    initLimits(events);

    await poll(tokenKey);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tokenKey).toBe(tokenKey);
  });
});

describe('LimitsService Claude /api/oauth/usage poll', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kotrain-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('parses the verified usage API JSON shape', async () => {
    const tokenKey = 'claude:acct-4';
    setToken(tokenKey, {
      provider: 'claude',
      accessToken: 'claude-access',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const payload = {
      five_hour: { utilization: 0.85, status: 'allowed', resets_at: '2026-04-11T07:00:00.528743+00:00' },
      seven_day: { utilization: 0.13, status: 'allowed', resets_at: '2026-04-17T00:59:59.951713+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 1.0, status: 'allowed', resets_at: '2026-04-16T03:00:00.951719+00:00' },
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    const limits = await poll(tokenKey);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer claude-access');
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20');

    expect(limits).toBeTruthy();
    expect(limits!.windows).toHaveLength(3); // opus window is null
    expect(limits!.windows.find((w) => w.id === '5h')).toMatchObject({ usedPercent: 85, status: 'warning' });
    expect(limits!.windows.find((w) => w.id === '7d')).toMatchObject({ usedPercent: 13, status: 'allowed' });
    expect(limits!.windows.find((w) => w.id === '7d_sonnet')).toMatchObject({ usedPercent: 100, status: 'rate_limited' });
  });
});

describe('getLimits', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'kotrain-limits-'));
    setDataDir(dir);
    vi.useFakeTimers();
    vi.setSystemTime(TEST_NOW);
  });

  it('returns fresh state without a network call', async () => {
    initLimits(new EventEmitter());
    recordFromHeaders('claude:fresh', 'anthropic', new Headers({
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-5h-reset': '1800000000',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
    }));

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const limits = await getLimits('claude:fresh');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(limits).toBeTruthy();
    expect(limits!.windows).toHaveLength(1);
  });

  it('polls when the stored state is stale', async () => {
    const tokenKey = 'chatgpt:stale';
    setToken(tokenKey, {
      provider: 'chatgpt',
      accessToken: 'chatgpt-access',
      accountId: 'stale',
      expiresAt: Date.now() + 120_000,
      obtainedAt: Date.now(),
    });

    const payload = {
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 5, limit_window_seconds: 18000, reset_at: 1778670307 },
        secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_at: 1779157165 },
      },
      credits: { has_credits: false, unlimited: false, balance: '0' },
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    initLimits(new EventEmitter());
    await getLimits(tokenKey);
    const state = get(tokenKey);
    expect(state).toBeTruthy();
    expect(state!.windows).toHaveLength(2);
  });
});
