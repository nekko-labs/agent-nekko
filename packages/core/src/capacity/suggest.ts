import type { FitPlan, FitRequest, FitSuggestion, ModelFacts } from '@agent-nekko/shared';
import { kvCacheBytes } from './kv.js';

/**
 * The fixes worth offering for a projection that does not fit.
 *
 * Every candidate is re-planned through `replan` before it is offered, so a chip
 * never proposes a change that would not actually help. That costs a handful of
 * pure function calls and buys the guarantee that clicking a suggestion always
 * improves the verdict.
 *
 * `replan` is injected rather than imported so this module stays free of a
 * circular dependency on plan.ts.
 */

interface SuggestOptions {
  siblings?: ModelFacts[];
}

const MAX_SUGGESTIONS = 3;
const MIN_CONTEXT = 512;
const GOOD: FitPlan['verdict'][] = ['fits', 'tight'];

export function suggestFixes(
  facts: ModelFacts,
  req: FitRequest,
  plan: FitPlan,
  opts: SuggestOptions,
  replan: (candidate: FitRequest) => FitPlan,
): FitSuggestion[] {
  // Nothing to fix, or nothing we can reason about.
  if (plan.verdict === 'fits' || plan.verdict === 'unknown') return [];

  const out: FitSuggestion[] = [];

  const smaller = largestFittingContext(req, facts, replan);
  if (smaller !== null && smaller < req.contextTokens) {
    out.push({
      label: `Drop context to ${formatTokens(smaller)} to fit`,
      savesBytes: kvDelta(facts, req, { ...req, contextTokens: smaller }),
      apply: { contextTokens: smaller },
    });
  }

  // A cheaper KV element is the least disruptive win available: same model, same
  // context, half the cache.
  if (req.kvCacheDtype === 'f16') {
    const candidate: FitRequest = { ...req, kvCacheDtype: 'q8_0' };
    const saves = kvDelta(facts, req, candidate);
    if (saves > 0 && isBetter(replan(candidate), plan)) {
      out.push({
        label: `Use a q8_0 KV cache to save ${formatBytes(saves)}`,
        savesBytes: saves,
        apply: { kvCacheDtype: 'q8_0' },
      });
    }
  }

  if (req.parallelSlots > 1) {
    const halved = Math.max(1, Math.floor(req.parallelSlots / 2));
    const candidate: FitRequest = { ...req, parallelSlots: halved };
    const saves = kvDelta(facts, req, candidate);
    if (saves > 0 && isBetter(replan(candidate), plan)) {
      out.push({
        label: `Cut parallel slots to ${halved} to save ${formatBytes(saves)}`,
        savesBytes: saves,
        apply: { parallelSlots: halved },
      });
    }
  }

  // A smaller build of the same model, when the provider offered us siblings.
  const sibling = bestSibling(facts, opts.siblings, plan);
  if (sibling) {
    out.push({
      label: `Load ${sibling.id} instead`,
      savesBytes: (facts.weightsBytes ?? 0) - (sibling.weightsBytes ?? 0),
      alternateModelId: sibling.id,
    });
  }

  return out.sort((a, b) => (b.savesBytes ?? 0) - (a.savesBytes ?? 0)).slice(0, MAX_SUGGESTIONS);
}

/**
 * Largest context that actually fits, found by halving down from the current
 * request. Halving keeps the answer on the round numbers people think in (64k,
 * 32k, 16k) instead of landing on 43,712.
 */
function largestFittingContext(
  req: FitRequest,
  facts: ModelFacts,
  replan: (candidate: FitRequest) => FitPlan,
): number | null {
  const ceiling = Math.min(req.contextTokens, facts.maxContext ?? req.contextTokens);
  let ctx = ceiling;
  // If the request was over the model's own maximum, the capped value may fit
  // on its own, so test it before halving.
  if (ctx < req.contextTokens && GOOD.includes(replan({ ...req, contextTokens: ctx }).verdict)) return ctx;
  while (ctx > MIN_CONTEXT) {
    ctx = Math.floor(ctx / 2);
    if (GOOD.includes(replan({ ...req, contextTokens: ctx }).verdict)) return ctx;
  }
  return null;
}

/** Bytes saved on the KV cache by moving from one request to another. */
function kvDelta(facts: ModelFacts, from: FitRequest, to: FitRequest): number {
  const a = kvCacheBytes(facts, from);
  const b = kvCacheBytes(facts, to);
  if (a === null || b === null) return 0;
  return Math.max(0, a - b);
}

/** A candidate is worth offering only if it moves the verdict in the right direction. */
function isBetter(candidate: FitPlan, current: FitPlan): boolean {
  const rank: Record<FitPlan['verdict'], number> = {
    fits: 4,
    tight: 3,
    spills: 2,
    'wont-load': 1,
    unknown: 0,
  };
  return rank[candidate.verdict] > rank[current.verdict];
}

/** The largest sibling build that would fit where this one does not. */
function bestSibling(
  facts: ModelFacts,
  siblings: ModelFacts[] | undefined,
  plan: FitPlan,
): ModelFacts | null {
  if (!siblings?.length || !facts.weightsBytes) return null;
  const room = plan.deviceFreeBytes - plan.kvCacheBytes - plan.overheadBytes;
  const candidates = siblings.filter(
    (s) => s.id !== facts.id && s.weightsBytes && s.weightsBytes < facts.weightsBytes! && s.weightsBytes <= room,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((best, s) => ((s.weightsBytes ?? 0) > (best.weightsBytes ?? 0) ? s : best));
}

function formatTokens(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function formatBytes(n: number): string {
  const gb = n / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}
