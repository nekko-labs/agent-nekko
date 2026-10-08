import { describe, expect, it } from 'vitest';
import {
  getModelPrice,
  estimateCost,
  estimateCostUSD,
  formatModelPriceLabel,
  MODEL_PRICING,
} from './limits.js';

describe('MODEL_PRICING', () => {
  it('keeps more-specific entries before broader ones', () => {
    const mini = MODEL_PRICING.findIndex((p) => p.match === 'gpt-4o-mini');
    const fourO = MODEL_PRICING.findIndex((p) => p.match === 'gpt-4o');
    expect(mini).toBeLessThan(fourO);
  });

  it('lists Claude prices with cache where published', () => {
    const sonnet = getModelPrice('claude-sonnet-4-6');
    expect(sonnet).toBeTruthy();
    expect(sonnet?.input).toBe(3);
    expect(sonnet?.output).toBe(15);
    expect(sonnet?.cacheWrite).toBe(3.75);
    expect(sonnet?.cacheRead).toBe(0.3);
  });
});

describe('getModelPrice', () => {
  it('matches by substring on the model id', () => {
    expect(getModelPrice('claude-opus-4-8')?.modelId).toBe('anthropic/claude-opus-4.8');
    expect(getModelPrice('openai/gpt-4o-mini')?.modelId).toBe('openai/gpt-4o-mini');
  });

  it('is case-insensitive', () => {
    expect(getModelPrice('Claude-Sonnet-4-6')?.modelId).toBe('anthropic/claude-sonnet-4.6');
  });

  it('prices published GPT-5 API variants without inventing subscription-only prices', () => {
    expect(getModelPrice('openai/gpt-5')?.input).toBe(1.25);
    expect(getModelPrice('gpt-5-mini')?.output).toBe(2);
    expect(getModelPrice('gpt-5-nano')?.input).toBe(0.05);
    expect(getModelPrice('gpt-5-codex')).toBeUndefined();
    expect(getModelPrice('gpt-5.6-sol')?.input).toBe(2);
    expect(getModelPrice('gpt-6-sol')?.input).toBe(2);
    expect(formatModelPriceLabel({ modelId: 'gpt-5', auth: 'apikey' })).toBe('$1.25/$10.00 per MTok');
    expect(formatModelPriceLabel({ modelId: 'gpt-6-sol', auth: 'subscription' })).toBe('Included in plan · ~$2.00/$10.00 per MTok');
    expect(estimateCost('gpt-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(11.25);
  });

  it('returns undefined for unknown or local models', () => {
    expect(getModelPrice('llama3.1:8b')).toBeUndefined();
    expect(getModelPrice('qwen2.5-coder-7b')).toBeUndefined();
    expect(getModelPrice('unknown-vendor-thing')).toBeUndefined();
  });

  it('returns undefined for an empty or missing model id', () => {
    expect(getModelPrice('')).toBeUndefined();
    expect(getModelPrice(undefined)).toBeUndefined();
  });

  it('prefers specific variants over their family prefix', () => {
    expect(getModelPrice('o1-mini')?.match).toBe('o1-mini');
    expect(getModelPrice('o1-mini')?.input).not.toBe(getModelPrice('o1')?.input);

    expect(getModelPrice('o3-mini')?.match).toBe('o3-mini');
    expect(getModelPrice('o3-mini')?.input).not.toBe(getModelPrice('o3')?.input);

    expect(getModelPrice('gpt-4.1-nano')?.match).toBe('gpt-4.1-nano');
    expect(getModelPrice('gpt-4.1-nano')?.input).not.toBe(getModelPrice('gpt-4.1')?.input);

    expect(getModelPrice('gpt-4.1-mini')?.match).toBe('gpt-4.1-mini');
    expect(getModelPrice('gpt-4.1-mini')?.input).not.toBe(getModelPrice('gpt-4.1')?.input);
  });
});

describe('estimateCost', () => {
  it('computes the list price for a known metered model', () => {
    const cost = estimateCost('claude-sonnet-4-6', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(18, 4);
  });

  it('returns 0 for subscription usage', () => {
    const cost = estimateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      auth: 'subscription',
    });
    expect(cost).toBe(0);
  });

  it('treats apikey auth as metered', () => {
    const cost = estimateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      auth: 'apikey',
    });
    expect(cost).toBeCloseTo(18, 4);
  });

  it('adds cache token prices when provided', () => {
    const cost = estimateCost('claude-sonnet-4-6', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(18 + 2 * 0.3 + 3.75, 4);
  });

  it('returns undefined for unknown models so the UI can hide the estimate', () => {
    expect(estimateCost('llama3.1:8b', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeUndefined();
  });

  it('matches by prefix / substring, not exact id', () => {
    expect(estimateCost('anthropic/claude-sonnet-4-6-latest', { inputTokens: 2_000_000, outputTokens: 0 })).toBe(6);
  });
});

describe('estimateCostUSD', () => {
  it('returns the same list price as estimateCost for known models', () => {
    expect(estimateCostUSD('gpt-4o-mini', 1_000_000, 1_000_000)).toBeCloseTo(0.75, 4);
  });

  it('returns 0 for unknown / local models', () => {
    expect(estimateCostUSD('llama3.1:8b', 1_000_000, 1_000_000)).toBe(0);
  });

  it('returns 0 when the model id is missing', () => {
    expect(estimateCostUSD(undefined, 1_000_000, 1_000_000)).toBe(0);
  });
});

describe('formatModelPriceLabel', () => {
  it('labels local models as Free', () => {
    expect(formatModelPriceLabel({ modelId: 'llama3.2', isLocal: true })).toBe('Free');
  });

  it('labels subscription usage as Included in plan with a muted list price', () => {
    expect(formatModelPriceLabel({ modelId: 'claude-sonnet-4-6', auth: 'subscription' }))
      .toBe('Included in plan · ~$3.00/$15.00 per MTok');
  });

  it('falls back to Included in plan when the subscription model has no list price', () => {
    expect(formatModelPriceLabel({ modelId: 'llama3.2', auth: 'subscription' })).toBe('Included in plan');
  });

  it('labels metered usage with the list price', () => {
    expect(formatModelPriceLabel({ modelId: 'claude-opus-4-8', auth: 'apikey' }))
      .toBe('$5.00/$25.00 per MTok');
  });

  it('returns undefined for unknown metered models', () => {
    expect(formatModelPriceLabel({ modelId: 'local-custom-7b', auth: 'apikey' })).toBeUndefined();
  });
});


describe('current subscription API equivalents', () => {
  it('prices published current models without billing subscription usage', () => {
    for (const [id, total] of [['gpt-6-astra', 60], ['gpt-6.1-sol', 12], ['gpt-6-luna', 0.6], ['gpt-5.6-sol', 12], ['gpt-5.6-cyber', 87.5]] as const) {
      expect(estimateCostUSD(id, 1_000_000, 1_000_000)).toBeCloseTo(total);
      expect(estimateCost(id, { inputTokens: 1_000_000, outputTokens: 1_000_000, auth: 'subscription' })).toBe(0);
    }
  });
  it('does not assign prices to unpublished variants', () => {
    expect(getModelPrice('gpt-6-unknown')).toBeUndefined();
    expect(getModelPrice('gpt-6-astra-codex')).toBeUndefined();
  });
});

 describe('published pricing snapshot', () => {
 it('corrects exact Fable pricing and uses distinct versioned rates', () => {
 expect(getModelPrice('claude-fable-5-1')).toMatchObject({input:10,output:50,cacheRead:0.25,modelId:'anthropic/claude-fable-5.1'});
 expect(getModelPrice('claude-opus-5-5')).toMatchObject({input:4,output:20});
 });
 it('matches known open model identities without guessing unknown sizes', () => {
 expect(getModelPrice('gpt-oss:120b')).toMatchObject({input:0.037,output:0.17});
 expect(getModelPrice('qwen3:32b')).toMatchObject({input:0.08,output:0.28});
 expect(getModelPrice('qwen3:8b-custom')).toBeUndefined();
 });
 });
