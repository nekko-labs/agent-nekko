/** Host-side subscription-limits capture and polling service. */

import { EventEmitter } from 'node:events';
import type { LimitWindow, OAuthProvider, ProviderKind, SubscriptionLimits } from '@agent-nekko/shared';
import { getToken, ensureFreshToken } from './oauth.js';
import { getSettings } from './store.js';

let events: EventEmitter | null = null;

const store = new Map<string, SubscriptionLimits>();
const lastPollByToken = new Map<string, number>();
const inFlight = new Map<string, Promise<SubscriptionLimits | undefined>>();

const POLL_INTERVAL_MS = 30_000;
const HEADER_STALE_MS = 60_000;
const POLL_STALE_MS = 35_000;

const ANTHROPIC_PREFIX = 'anthropic-ratelimit-unified-';

const ANTHROPIC_WINDOWS: Array<{
  id: string;
  scope: LimitWindow['scope'];
  label: string;
  headerSuffix: string;
  jsonKey: string;
  modelId?: string;
}> = [
  { id: '5h', scope: 'session', label: '5-hour', headerSuffix: '5h', jsonKey: 'five_hour' },
  { id: '7d', scope: 'weekly', label: '7-day', headerSuffix: '7d', jsonKey: 'seven_day' },
  {
    id: '7d_sonnet',
    scope: 'model',
    label: '7-day Sonnet',
    headerSuffix: '7d_sonnet',
    jsonKey: 'seven_day_sonnet',
    modelId: 'claude-sonnet-4-6',
  },
  {
    id: '7d_opus',
    scope: 'model',
    label: '7-day Opus',
    headerSuffix: '7d_opus',
    jsonKey: 'seven_day_opus',
    modelId: 'claude-opus-4-8',
  },
];

/** Wire the service to the host's event bus. Called once in createHost. */
export function initLimits(eventBus: EventEmitter): void {
  events = eventBus;
  store.clear();
  lastPollByToken.clear();
  inFlight.clear();
}

/** Drop all cached state for a token key, or for every key if omitted. */
export function clearLimits(tokenKey?: string): void {
  if (tokenKey) {
    store.delete(tokenKey);
    lastPollByToken.delete(tokenKey);
    inFlight.delete(tokenKey);
  } else {
    store.clear();
    lastPollByToken.clear();
    inFlight.clear();
  }
}

/** Latest normalized state for a token key, or undefined if none captured yet. */
export function get(tokenKey: string): SubscriptionLimits | undefined {
  return store.get(tokenKey);
}

/**
 * Return the latest state, polling first if it is missing or stale.
 * The poll is throttled, so this is safe to call from UI refresh paths.
 * If the cached snapshot is stale and the poll cannot refresh it, this
 * returns `undefined` rather than handing back the stale snapshot as fresh.
 */
export async function getLimits(tokenKey: string): Promise<SubscriptionLimits | undefined> {
  const state = get(tokenKey);
  if (state && state.updatedAt + state.staleAfterMs > Date.now()) {
    return state;
  }
  const polled = await poll(tokenKey);
  if (!polled) return undefined;
  if (polled.updatedAt + polled.staleAfterMs <= Date.now()) return undefined;
  return polled;
}

/**
 * Capture provider rate-limit headers from a subscription response.
 * Anthropic headers are only parsed for the anthropic/claude provider;
 * other providers' headers are left alone. If no recognized headers are
 * present, the existing state is left unchanged.
 */
export function recordFromHeaders(
  tokenKey: string,
  provider: OAuthProvider | ProviderKind,
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): SubscriptionLimits | undefined {
  if (provider !== 'anthropic' && provider !== 'claude') {
    return get(tokenKey);
  }
  const limits = parseAnthropicHeaders(headers);
  if (limits.windows.length === 0) {
    return get(tokenKey);
  }
  store.set(tokenKey, limits);
  const bus = events;
  if (bus) {
    try {
      bus.emit('limitsUpdated', { tokenKey, limits });
    } catch {
      // A throwing observer must not abort an in-flight chat turn.
    }
  }
  return limits;
}

/**
 * On-demand provider poll. Throttled to at most once every 30 seconds per
 * token key. Fetches the authoritative usage endpoint for Claude or ChatGPT.
 */
export async function poll(tokenKey: string): Promise<SubscriptionLimits | undefined> {
  const token = getToken(tokenKey);
  if (!token) return get(tokenKey);

  const now = Date.now();
  const last = lastPollByToken.get(tokenKey) ?? 0;
  if (now - last < POLL_INTERVAL_MS) {
    return get(tokenKey);
  }

  const existing = inFlight.get(tokenKey);
  if (existing) return existing;

  const bus = events;
  let promise!: Promise<SubscriptionLimits | undefined>;
  promise = (async (): Promise<SubscriptionLimits | undefined> => {
    try {
      const accessToken = await ensureFreshToken(tokenKey);
      const fresh = getToken(tokenKey);
      if (!fresh) return get(tokenKey);

      let next: SubscriptionLimits | undefined;
      if (fresh.provider === 'claude') {
        next = await pollClaude(tokenKey, accessToken);
      } else if (fresh.provider === 'chatgpt') {
        next = await pollChatGpt(tokenKey, accessToken, fresh.accountId);
      } else {
        next = get(tokenKey);
      }

      if (inFlight.get(tokenKey) !== promise) {
        return get(tokenKey);
      }
      if (next) {
        store.set(tokenKey, next);
        try {
          bus?.emit('limitsUpdated', { tokenKey, limits: next });
        } catch {
          // A throwing observer must not abort a background poll.
        }
      }
      lastPollByToken.set(tokenKey, Date.now());
      return next ?? get(tokenKey);
    } catch {
      return get(tokenKey);
    } finally {
      if (inFlight.get(tokenKey) === promise) inFlight.delete(tokenKey);
    }
  })();

  inFlight.set(tokenKey, promise);
  return promise;
}

async function pollClaude(tokenKey: string, accessToken: string): Promise<SubscriptionLimits | undefined> {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
  });
  if (!res.ok) return undefined;

  const text = await res.text();
  const json = safeJson(text);
  if (!json || typeof json !== 'object') return undefined;

  return parseAnthropicUsageJson(json as Record<string, unknown>);
}

async function pollChatGpt(
  tokenKey: string,
  accessToken: string,
  accountId: string | undefined,
): Promise<SubscriptionLimits | undefined> {
  if (!accountId) return undefined;

  const configuredBase = getSettings().providers.find((p) => p.tokenKey === tokenKey)?.baseUrl;
  const baseUrl = (configuredBase ?? 'https://chatgpt.com/backend-api').replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/wham/usage`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
    },
  });
  if (!res.ok) return undefined;

  const text = await res.text();
  const json = safeJson(text);
  if (!json || typeof json !== 'object') return undefined;

  return parseChatGptUsage(json as Record<string, unknown>);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headerMap(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((v, k) => map.set(k.toLowerCase(), v));
  } else if (typeof (headers as Iterable<[string, string]>)[Symbol.iterator] === 'function') {
    for (const [k, v] of headers as Iterable<[string, string]>) {
      map.set(k.toLowerCase(), v);
    }
  } else {
    for (const [k, v] of Object.entries(headers as Record<string, string>)) {
      map.set(k.toLowerCase(), v);
    }
  }
  return map;
}

function getHeader(
  map: Map<string, string>,
  name: string,
): string | undefined {
  return map.get(name.toLowerCase());
}

function normalizeStatus(value: string | undefined): LimitWindow['status'] {
  const s = value?.toLowerCase() ?? '';
  if (s === 'rate_limited' || s === 'rejected') return 'rate_limited';
  if (s === 'warning' || s === 'allowed_warning') return 'warning';
  return 'allowed';
}

function parseAnthropicHeaders(
  headers: Headers | Record<string, string> | Iterable<[string, string]>,
): SubscriptionLimits {
  const map = headerMap(headers);
  const windows: LimitWindow[] = [];

  for (const spec of ANTHROPIC_WINDOWS) {
    const util = getHeader(map, `${ANTHROPIC_PREFIX}${spec.headerSuffix}-utilization`);
    if (util == null) continue;

    const utilization = parseFloat(util);
    if (!Number.isFinite(utilization)) continue;

    const reset = getHeader(map, `${ANTHROPIC_PREFIX}${spec.headerSuffix}-reset`);
    const resetAt = reset ? parseInt(reset, 10) * 1000 : 0;
    const status = normalizeStatus(
      getHeader(map, `${ANTHROPIC_PREFIX}${spec.headerSuffix}-status`) ?? 'allowed',
    );

    windows.push({
      id: spec.id,
      label: spec.label,
      scope: spec.scope,
      modelId: spec.modelId,
      usedPercent: Math.round(utilization * 100 * 100) / 100,
      resetAt,
      status,
    });
  }

  return { windows, updatedAt: Date.now(), staleAfterMs: HEADER_STALE_MS };
}

function parseAnthropicUsageJson(json: Record<string, unknown>): SubscriptionLimits {
  const windows: LimitWindow[] = [];

  for (const spec of ANTHROPIC_WINDOWS) {
    const win = json[spec.jsonKey];
    if (!win || typeof win !== 'object' || win === null) continue;

    const obj = win as Record<string, unknown>;
    const utilization =
      typeof obj.utilization === 'number'
        ? obj.utilization
        : parseFloat(String(obj.utilization ?? ''));
    if (!Number.isFinite(utilization)) continue;

    const resetsAt = typeof obj.resets_at === 'string' ? Date.parse(obj.resets_at) : 0;
    const reported = normalizeStatus(typeof obj.status === 'string' ? obj.status : undefined);
    let status: LimitWindow['status'] = 'allowed';
    if (reported === 'rate_limited' || utilization >= 1.0) {
      status = 'rate_limited';
    } else if (reported === 'warning' || utilization >= 0.8) {
      status = 'warning';
    }

    windows.push({
      id: spec.id,
      label: spec.label,
      scope: spec.scope,
      modelId: spec.modelId,
      usedPercent: Math.round(utilization * 100 * 100) / 100,
      resetAt: resetsAt > 0 ? resetsAt : 0,
      status,
    });
  }

  return { windows, updatedAt: Date.now(), staleAfterMs: POLL_STALE_MS };
}

function parseChatGptUsage(json: Record<string, unknown>): SubscriptionLimits {
  const windows: LimitWindow[] = [];
  const rateLimit = json.rate_limit as Record<string, unknown> | undefined;
  const planType = typeof json.plan_type === 'string' ? json.plan_type : undefined;

  let creditsBalance: number | undefined;
  const credits = json.credits as Record<string, unknown> | undefined;
  if (credits) {
    if (credits.unlimited === true) {
      creditsBalance = undefined;
    } else if (credits.has_credits === true && (typeof credits.balance === 'string' || typeof credits.balance === 'number')) {
      const v = parseFloat(String(credits.balance));
      if (Number.isFinite(v)) creditsBalance = v;
    } else if (typeof credits.balance === 'string' || typeof credits.balance === 'number') {
      const v = parseFloat(String(credits.balance));
      if (Number.isFinite(v)) creditsBalance = v;
    }
  }

  if (rateLimit) {
    const allowed = rateLimit.allowed === true;
    const limitReached = rateLimit.limit_reached === true;

    const addWindow = (
      key: 'primary_window' | 'secondary_window',
      id: string,
      scope: LimitWindow['scope'],
      label: string,
    ) => {
      const win = rateLimit[key] as Record<string, unknown> | undefined;
      if (!win) return;

      const usedPercent =
        typeof win.used_percent === 'number'
          ? win.used_percent
          : parseFloat(String(win.used_percent ?? ''));
      if (!Number.isFinite(usedPercent)) return;

      const resetAt =
        typeof win.reset_at === 'number' ? win.reset_at * 1000 : 0;

      let status: LimitWindow['status'] = 'allowed';
      if (!allowed || limitReached) {
        status = 'rate_limited';
      } else if (usedPercent >= 80) {
        status = 'warning';
      }

      windows.push({
        id,
        label,
        scope,
        usedPercent: Math.round(usedPercent * 100) / 100,
        resetAt,
        status,
      });
    };

    addWindow('primary_window', '5h', 'session', '5-hour');
    addWindow('secondary_window', '7d', 'weekly', '7-day');
  }

  return { windows, planType, creditsBalance, updatedAt: Date.now(), staleAfterMs: POLL_STALE_MS };
}
