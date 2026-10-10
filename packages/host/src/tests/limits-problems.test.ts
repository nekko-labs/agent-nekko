import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeLimitsProblem } from '@nekko-agent/shared';
import { setDataDir } from '../paths.js';
import { setToken } from '../oauth.js';
import { classifyLimitsError, getLimitsProblem, initLimits, limitsBackoffMs, parseRetryAfter, poll } from '../limits.js';

const NOW = 1_700_000_000_000;
const usage = { plan_type: 'plus', rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1778670307 } } };
const ok = () => new Response(JSON.stringify(usage), { status: 200 });

function signIn(tokenKey: string, extra: Partial<Parameters<typeof setToken>[1]> = {}) {
  setToken(tokenKey, { provider: 'chatgpt', accessToken: 'a', accountId: 'acct', expiresAt: Date.now() + 3_600_000, obtainedAt: Date.now(), ...extra });
}

beforeEach(() => {
  setDataDir(mkdtempSync(join(tmpdir(), 'nekko-limits-problem-')));
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  initLimits(new EventEmitter());
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('quota read failures', () => {
  it('reports a 429 with its Retry-After and waits it out', async () => {
    signIn('chatgpt:rl');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '600' } }));
    await poll('chatgpt:rl');
    const problem = getLimitsProblem('chatgpt:rl')!;
    expect(problem).toMatchObject({ kind: 'rate_limited', status: 429, failures: 1, retryAt: NOW + 600_000 });
    expect(describeLimitsProblem(problem, NOW)).toMatch(/^Rate limited by the provider\. Retrying at /);

    // Past the 30s throttle but inside Retry-After: no request goes out.
    vi.setSystemTime(NOW + 120_000);
    await poll('chatgpt:rl');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After it, one retry; success clears the problem.
    fetchMock.mockResolvedValue(ok());
    vi.setSystemTime(NOW + 601_000);
    expect(await poll('chatgpt:rl')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getLimitsProblem('chatgpt:rl')).toBeUndefined();
  });

  it('backs off exponentially on repeated failures, capped', async () => {
    signIn('chatgpt:500');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    await poll('chatgpt:500');
    expect(getLimitsProblem('chatgpt:500')).toMatchObject({ kind: 'http', status: 503, failures: 1, retryAt: NOW + 60_000 });
    vi.setSystemTime(NOW + 60_000);
    await poll('chatgpt:500');
    expect(getLimitsProblem('chatgpt:500')).toMatchObject({ failures: 2, retryAt: NOW + 60_000 + 120_000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(limitsBackoffMs(20)).toBe(30 * 60_000);
    expect(limitsBackoffMs(1, 5 * 60_000)).toBe(5 * 60_000);
  });

  it('stops asking after an expired sign-in until the token changes', async () => {
    // The live case: access token expired, refresh rejected by the token endpoint.
    signIn('chatgpt:dead', { expiresAt: NOW - 1000, refreshToken: 'r' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    await poll('chatgpt:dead');
    const problem = getLimitsProblem('chatgpt:dead')!;
    expect(problem.kind).toBe('auth_expired');
    expect(problem.retryAt).toBeUndefined();
    expect(describeLimitsProblem(problem)).toBe('Sign-in expired. Sign in again in Settings.');

    // Hours later, still no request: it waits for the user.
    vi.setSystemTime(NOW + 6 * 3_600_000);
    await poll('chatgpt:dead');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A new sign-in (newer obtainedAt) resumes reads.
    signIn('chatgpt:dead');
    fetchMock.mockResolvedValue(ok());
    expect(await poll('chatgpt:dead')).toBeTruthy();
    expect(getLimitsProblem('chatgpt:dead')).toBeUndefined();
  });

  it('treats 401/403 from the usage endpoint as an expired sign-in', async () => {
    signIn('chatgpt:401');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 401 }));
    await poll('chatgpt:401');
    expect(getLimitsProblem('chatgpt:401')).toMatchObject({ kind: 'auth_expired', status: 401 });
  });

  it('reports a missing sign-in and an unreachable provider', async () => {
    await poll('chatgpt:nobody');
    expect(getLimitsProblem('chatgpt:nobody')?.kind).toBe('signed_out');

    signIn('chatgpt:offline');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await poll('chatgpt:offline');
    expect(getLimitsProblem('chatgpt:offline')).toMatchObject({ kind: 'network', retryAt: NOW + 60_000 });
  });

  it('classifies refresh and parsing errors and Retry-After forms', () => {
    expect(classifyLimitsError(new Error('Subscription session expired. Sign in again.')).kind).toBe('auth_expired');
    expect(classifyLimitsError(new Error('No subscription token found for x. Sign in again.')).kind).toBe('auth_expired');
    expect(classifyLimitsError(new Error('Token refresh failed: server error')).kind).toBe('http');
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90_000);
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
  });
});
