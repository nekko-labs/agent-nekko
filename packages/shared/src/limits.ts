/** Subscription limit state and per-model list-price estimates. */

/** A single provider-side usage/limit window, normalized across vendors. */
export interface LimitWindow {
  id: string;
  label: string;
  scope: 'session' | 'weekly' | 'model';
  /**
   * For model-scoped windows, the family this window tracks as a lowercase
   * substring of the model ids it covers (`opus`, `sonnet`, …). A family rather
   * than an exact id on purpose: the window applies to every generation of that
   * model, so `opus` keeps covering `claude-opus-5` after `claude-opus-4-8`.
   */
  modelFamily?: string;
  /** 0-100 percentage of the limit currently used. */
  usedPercent: number;
  /** Epoch milliseconds when this window resets. */
  resetAt: number;
  /** Provider-side status for this window. */
  status: 'allowed' | 'warning' | 'rate_limited';
}

/** Normalized subscription limits for one signed-in account. */
export interface SubscriptionLimits {
  windows: LimitWindow[];
  /** Provider plan name, e.g. "plus" for ChatGPT. */
  planType?: string;
  /** USD credit balance, or undefined / Infinity when the plan is unlimited. */
  creditsBalance?: number;
  /** Epoch milliseconds when this snapshot was captured. */
  updatedAt: number;
  /** How long after `updatedAt` the snapshot should be considered stale. */
  staleAfterMs: number;
}

/** Published list-price entry for a model family ($/MTok). */
export interface ModelPricing {
  /** Substring match against a model id, e.g. "sonnet" matches any claude-sonnet id. */
  match: string;
  /** Input tokens, USD per 1M. */
  input: number;
  /** Output tokens, USD per 1M. */
  output: number;
  /** Cached read tokens, USD per 1M, when published. */
  cacheRead?: number;
  /** Cached write tokens, USD per 1M, when published. */
  cacheWrite?: number;
}

/**
 * Conservative list prices (USD per 1M tokens). Match is a substring of the
 * model id. `getModelPrice` picks the entry with the longest matching substring
 * so specific variants (e.g. `o1-mini`) are not shadowed by their family prefix.
 * Unknown / local models have no entry, so the UI can honestly say "no
 * estimate" while usage accounting falls back to $0.
 */
export const MODEL_PRICING: ModelPricing[] = [
  { match: 'claude-opus', input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.50 },
  { match: 'claude-sonnet', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  { match: 'claude-fable', input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.30 },
  { match: 'claude-haiku', input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.10 },
  { match: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { match: 'gpt-4o', input: 2.5, output: 10 },
  { match: 'gpt-4.1-nano', input: 0.10, output: 0.40 },
  { match: 'gpt-4.1-mini', input: 0.40, output: 1.60 },
  { match: 'gpt-4.1', input: 2, output: 8 },
  { match: 'o3-mini', input: 1.10, output: 4.40 },
  { match: 'o3', input: 2, output: 8 },
  { match: 'o1-mini', input: 1.10, output: 4.40 },
  { match: 'o1', input: 15, output: 60 },
  { match: 'gpt-3.5', input: 0.5, output: 1.5 },
];

/** Find the pricing entry whose match is the longest substring of `modelId`. */
export function getModelPrice(modelId: string | undefined): ModelPricing | undefined {
  if (!modelId) return undefined;
  const id = modelId.toLowerCase();
  return [...MODEL_PRICING]
    .sort((a, b) => b.match.length - a.match.length)
    .find((p) => id.includes(p.match));
}

export interface EstimateCostInputs {
  /** Non-cached input/prompt tokens. Do not include cached tokens here. */
  inputTokens: number;
  /** Non-cached output/completion tokens. Do not include cached tokens here. */
  outputTokens: number;
  /** Cached read tokens, priced separately from `inputTokens`. */
  cacheReadTokens?: number;
  /** Cached write tokens, priced separately from `inputTokens`. */
  cacheWriteTokens?: number;
  /** Subscription plans bill through the plan, not per token. */
  auth?: 'apikey' | 'subscription';
}

/**
 * Estimated USD cost for a usage record. Returns `undefined` when the model
 * has no published price, so callers can avoid showing a wrong number.
 * Subscription auth always returns 0 (the usage is included in the plan).
 *
 * `inputTokens` and `outputTokens` must be the non-cached prompt and
 * generation counts; cached reads and writes are priced separately via
 * `cacheReadTokens` and `cacheWriteTokens`. Including cached tokens in the
 * main counts would double-count them.
 */
export function estimateCost(
  modelId: string | undefined,
  usage: EstimateCostInputs,
): number | undefined {
  if (!modelId) return undefined;
  if (usage.auth === 'subscription') return 0;
  const p = getModelPrice(modelId);
  if (!p) return undefined;
  let cost = (usage.inputTokens / 1e6) * p.input + (usage.outputTokens / 1e6) * p.output;
  if (usage.cacheReadTokens && p.cacheRead) {
    cost += (usage.cacheReadTokens / 1e6) * p.cacheRead;
  }
  if (usage.cacheWriteTokens && p.cacheWrite) {
    cost += (usage.cacheWriteTokens / 1e6) * p.cacheWrite;
  }
  return cost;
}

/**
 * Backward-compatible numeric cost estimate. Unknown / local / unpriced models
 * return 0; this is the function the existing usage log already calls.
 */
export function estimateCostUSD(modelId: string | undefined, input: number, output: number): number {
  return estimateCost(modelId, { inputTokens: input, outputTokens: output }) ?? 0;
}

/** Inputs for `formatModelPriceLabel`. */
export interface ModelPriceLabelInputs {
  modelId: string;
  /** Provider auth mode. */
  auth?: 'apikey' | 'subscription';
  /** Whether the provider is a local on-device server (free). */
  isLocal?: boolean;
}

/**
 * Text label for a model option in a picker or list:
 * - local models: "Free"
 * - subscription auth: "Included in plan" + muted equivalent list price
 * - metered API key: "$in/$out per MTok"
 * - unknown / unpriced: undefined, so the UI shows nothing rather than a wrong number.
 */
export function formatModelPriceLabel({ modelId, auth, isLocal }: ModelPriceLabelInputs): string | undefined {
  if (isLocal) return 'Free';
  if (auth === 'subscription') {
    const p = getModelPrice(modelId);
    if (!p) return 'Included in plan';
    return `Included in plan · ~$${p.input.toFixed(2)}/$${p.output.toFixed(2)} per MTok`;
  }
  const p = getModelPrice(modelId);
  if (!p) return undefined;
  return `$${p.input.toFixed(2)}/$${p.output.toFixed(2)} per MTok`;
}
