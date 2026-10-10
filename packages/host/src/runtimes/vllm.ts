import {
  RUNTIME_CAPABILITIES,
  type ModelFacts,
  type RuntimeDetection,
  type RuntimeMetrics,
  type RuntimeStatus,
  type StopResult,
} from '@agent-nekko/shared';
import { apiRoot, getJson, trimUrl, type RuntimeAdapter, type RuntimeContext } from './types.js';

/**
 * vLLM adapter, connect-existing only.
 *
 * vLLM is a different shape from the other two: one model per process, every
 * setting fixed by the launch command, and no way to load a second model into a
 * running server. It is also Linux plus NVIDIA plus Python in practice, which
 * neither of the machines this was built on can run.
 *
 * So this adapter deliberately has no `start`. We detect a running server, read
 * what it is serving, surface its /metrics, and can stop it. The fit planner
 * still does the math and renders the `vllm serve` flags for the user to run
 * themselves, which is honest about what we have verified and what we have not.
 * Revisit when there is real hardware to test a spawn path against.
 */

export function createVllmAdapter(ctx: RuntimeContext): RuntimeAdapter {
  return {
    kind: 'vllm',
    capabilities: RUNTIME_CAPABILITIES.vllm,

    async detect(baseUrl: string): Promise<RuntimeDetection> {
      const models = await getJson<{ data?: unknown[] }>(ctx, `${trimUrl(baseUrl)}/models`, 2500);
      return {
        kind: 'vllm',
        running: models !== null,
        // We never start vLLM, so "installed" is not a thing we claim to know.
        installed: false,
        reason:
          'vLLM is managed outside Agent Nekko: it serves one model per process, configured at launch. Start it yourself with the command shown in the fit drawer.',
      };
    },

    async status(baseUrl: string): Promise<RuntimeStatus> {
      const models = await getJson<{ data?: Array<{ id: string }> }>(ctx, `${trimUrl(baseUrl)}/models`, 2500);
      const metricsText = await fetchText(ctx, `${apiRoot(baseUrl)}/metrics`);
      return {
        kind: 'vllm',
        running: models !== null,
        installed: false,
        owned: false,
        baseUrl,
        // vLLM serves exactly what it was launched with, so everything listed is
        // resident by definition. It publishes no per-model byte figures.
        resident: (models?.data ?? []).map((m) => ({ id: m.id })),
        metrics: metricsText ? parseVllmMetrics(metricsText) : undefined,
      };
    },

    async listModels(baseUrl: string): Promise<ModelFacts[]> {
      const models = await getJson<{ data?: Array<{ id: string; max_model_len?: number }> }>(
        ctx,
        `${trimUrl(baseUrl)}/models`,
        6000,
      );
      return (models?.data ?? []).map((m) => ({
        id: m.id,
        providerId: baseUrl,
        maxContext: m.max_model_len,
        loaded: true,
      }));
    },

    async stop(): Promise<StopResult> {
      // Routed through the supervisor, which owns process work and the
      // confirmation for killing something we did not start.
      return { ok: false, message: 'Stopping is handled by the supervisor.' };
    },
  };
}

/**
 * Pull the three numbers worth showing out of vLLM's Prometheus text.
 *
 * The format is one `name{labels} value` per line with `#` comments, so a regex
 * per metric is enough and pulling in a Prometheus parser would not earn its
 * dependency.
 */
export function parseVllmMetrics(text: string): RuntimeMetrics {
  const out: RuntimeMetrics = {};
  const running = metricValue(text, 'vllm:num_requests_running');
  const waiting = metricValue(text, 'vllm:num_requests_waiting');
  const kv = metricValue(text, 'vllm:kv_cache_usage_perc');
  if (running !== null) out.requestsRunning = running;
  if (waiting !== null) out.requestsWaiting = waiting;
  // Published as a 0..1 fraction; the UI wants a percentage.
  if (kv !== null) out.kvCacheUsagePct = kv * 100;
  return out;
}

function metricValue(text: string, name: string): number | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!trimmed.startsWith(name)) continue;
    // Either `name value` or `name{labels} value`.
    const value = Number(trimmed.slice(trimmed.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

async function fetchText(ctx: RuntimeContext, url: string): Promise<string | null> {
  try {
    // /metrics is absent when vLLM runs with --disable-log-stats, which is not
    // an error worth surfacing.
    const res = await ctx.fetch(url);
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}
