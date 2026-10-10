import { describe, it, expect } from 'vitest';
import { recommendModel, pickAutoModel, pickAcrossProviders, providerSwitchTrigger, isComplexPrompt, modelTier } from '@nekko-agent/shared';
import type { ModelInfo, ProviderPool, SubscriptionLimits } from '@nekko-agent/shared';

const model = (id: string, name = id): ModelInfo => ({ id, providerId: 'p', name });

describe('isComplexPrompt', () => {
  it('treats coding/architecture asks as complex', () => {
    expect(isComplexPrompt('Implement a binary search tree')).toBe(true);
    expect(isComplexPrompt('Help me debug this crash')).toBe(true);
    expect(isComplexPrompt('refactor the auth module')).toBe(true);
  });
  it('treats short factual asks as simple', () => {
    expect(isComplexPrompt('what is the capital of France?')).toBe(false);
    expect(isComplexPrompt('thanks!')).toBe(false);
  });
  it('long prompts and code blocks are complex', () => {
    expect(isComplexPrompt('x'.repeat(700))).toBe(true);
    expect(isComplexPrompt('look at ```const x=1```')).toBe(true);
  });
});

describe('modelTier', () => {
  it('ranks frontier > mid > small', () => {
    expect(modelTier(model('claude-opus-4'))).toBeGreaterThan(modelTier(model('claude-sonnet-4')));
    expect(modelTier(model('claude-sonnet-4'))).toBeGreaterThan(modelTier(model('claude-haiku')));
    expect(modelTier(model('gpt-4o'))).toBeGreaterThan(modelTier(model('gpt-4o-mini')));
  });
});

describe('recommendModel', () => {
  const models = [model('claude-haiku', 'Haiku'), model('claude-sonnet-4', 'Sonnet'), model('claude-opus-4', 'Opus')];

  it('returns null for no models, the only model for one', () => {
    expect(recommendModel([], 'hi')).toBeNull();
    expect(recommendModel([model('solo')], 'hi')).toBe('solo');
  });

  it('picks the strongest model for complex prompts', () => {
    expect(recommendModel(models, 'Implement and debug a distributed lock')).toBe('claude-opus-4');
  });

  it('picks a small capable model for quick prompts', () => {
    expect(recommendModel(models, 'what time is it in Tokyo?')).toBe('claude-haiku');
  });

  it('breaks ties toward preferred (favorited) models', () => {
    const two = [model('a-mini', 'A mini'), model('b-mini', 'B mini')];
    // both small tier → favorite wins
    expect(recommendModel(two, 'hello', new Set(['b-mini']))).toBe('b-mini');
  });
});

describe('pickAutoModel profiles', () => {
  const models = [model('claude-haiku', 'Haiku'), model('claude-sonnet-4', 'Sonnet'), model('claude-opus-4', 'Opus')];
  const complex = 'Implement and debug a distributed lock';
  const quick = 'what time is it in Tokyo?';

  it('cheap stays small no matter how hard the prompt is', () => {
    expect(pickAutoModel(models, complex, { quality: 'cheap' })?.modelId).toBe('claude-haiku');
    expect(pickAutoModel(models, quick, { quality: 'cheap' })?.modelId).toBe('claude-haiku');
  });

  it('quality stays strong even for a throwaway question', () => {
    expect(pickAutoModel(models, quick, { quality: 'quality' })?.modelId).toBe('claude-opus-4');
    expect(pickAutoModel(models, complex, { quality: 'quality' })?.modelId).toBe('claude-opus-4');
  });

  it('normal reads the prompt and moves between them', () => {
    expect(pickAutoModel(models, complex, { quality: 'normal' })?.modelId).toBe('claude-opus-4');
    expect(pickAutoModel(models, quick, { quality: 'normal' })?.modelId).toBe('claude-haiku');
  });

  it('never picks a speech, embedding, or image model', () => {
    const mixed = [
      model('whisper-large-v3', 'Whisper Large v3'),
      model('parakeet-unified-en-0.6b', 'Parakeet'),
      model('text-embedding-3-large', 'Embedding 3 Large'),
      model('stable-diffusion-xl', 'SDXL'),
      model('unlimited-ocr', 'Unlimited OCR'),
      model('translate', 'Translate'),
      model('qwen2.5-7b-instruct', 'Qwen 7B'),
    ];
    expect(pickAutoModel(mixed, complex, { quality: 'quality' })?.modelId).toBe('qwen2.5-7b-instruct');
    expect(pickAutoModel(mixed, quick, { quality: 'cheap' })?.modelId).toBe('qwen2.5-7b-instruct');
  });

  it('falls back to whatever exists when nothing looks like a chat model', () => {
    const only = [model('whisper-large-v3', 'Whisper')];
    expect(pickAutoModel(only, quick)?.modelId).toBe('whisper-large-v3');
  });

  it('reports the pick with a name and a reason, and nothing at all when empty', () => {
    const pick = pickAutoModel(models, quick);
    expect(pick?.name).toBe('Haiku');
    expect(pick?.reason).toMatch(/quick question/i);
    expect(pick?.complex).toBe(false);
    expect(pickAutoModel([], quick)).toBeNull();
  });
});

describe('pickAcrossProviders', () => {
  const prompt = 'what time is it in Tokyo?';
  const home = (limits?: SubscriptionLimits): ProviderPool => ({
    providerId: 'claude', providerLabel: 'Claude', auth: 'subscription', tokenKey: 'claude:acct',
    models: [model('claude-haiku', 'Haiku'), model('claude-sonnet-4', 'Sonnet'), model('claude-opus-4', 'Opus')],
    limits,
  });
  const spent7d: SubscriptionLimits = {
    windows: [{ id: '7d', label: '7-day', scope: 'weekly', usedPercent: 100, resetAt: Date.now() + 86_400_000, status: 'rate_limited' }],
    updatedAt: Date.now(), staleAfterMs: 30_000,
  };
  const nearSpent: SubscriptionLimits = {
    windows: [{ id: '5h', label: '5-hour', scope: 'session', usedPercent: 97, resetAt: Date.now() + 3_600_000, status: 'warning' }],
    updatedAt: Date.now(), staleAfterMs: 30_000,
  };
  const headroom40: SubscriptionLimits = {
    windows: [{ id: '5h', label: '5-hour', scope: 'session', usedPercent: 40, resetAt: Date.now() + 3_600_000, status: 'allowed' }],
    updatedAt: Date.now(), staleAfterMs: 30_000,
  };
  const headroom80: SubscriptionLimits = {
    windows: [{ id: '5h', label: '5-hour', scope: 'session', usedPercent: 20, resetAt: Date.now() + 3_600_000, status: 'allowed' }],
    updatedAt: Date.now(), staleAfterMs: 30_000,
  };
  const alt = (id: string, label: string, models: ModelInfo[], limits?: SubscriptionLimits): ProviderPool => ({
    providerId: id, providerLabel: label, models, limits,
  });

  it('keeps the home pick while the provider can serve', () => {
    const pick = pickAcrossProviders([home(headroom40)], prompt, { homeProviderId: 'claude', switchOnCapacity: true });
    expect(pick?.switched).toBe(false);
    expect(pick?.providerId).toBe('claude');
  });

  it('never switches when the option is off, even with the provider spent', () => {
    const pick = pickAcrossProviders([home(spent7d), alt('or', 'OpenRouter', [model('gpt-4o', 'GPT-4o')])], prompt, {
      homeProviderId: 'claude',
      switchOnCapacity: false,
    });
    expect(pick?.switched).toBe(false);
    expect(pick?.providerId).toBe('claude');
  });

  it('moves the turn to an equivalent-tier model with the most headroom, and says why', () => {
    const pick = pickAcrossProviders(
      [
        home(spent7d),
        alt('or', 'OpenRouter', [model('gpt-5', 'GPT-5')], headroom80),
        alt('oai', 'OpenAI', [model('o1-pro', 'o1 pro')], headroom40),
      ],
      'Implement and debug a distributed lock',
      { homeProviderId: 'claude', switchOnCapacity: true },
    );
    expect(pick?.switched).toBe(true);
    // Complex prompt wants the strongest (Opus, tier 5); both candidates match
    // the tier, so the pick is the one with the most headroom: OpenRouter's
    // GPT-5 at 80% free.
    expect(pick?.providerId).toBe('or');
    expect(pick?.reason).toMatch(/limit is used up/i);
    expect(pick?.reason).toContain('OpenRouter');
  });

  it('never downgrades: only lower-tier models elsewhere keeps the home pick', () => {
    const pick = pickAcrossProviders(
      [home(spent7d), alt('local', 'Local', [model('gemma-3-4b', 'Gemma 4B')])],
      'Implement and debug a distributed lock',
      { homeProviderId: 'claude', switchOnCapacity: true },
    );
    expect(pick?.switched).toBe(false);
    expect(pick?.providerId).toBe('claude');
  });

  it('allows a step up and says so in the reason', () => {
    const pick = pickAcrossProviders(
      [home(nearSpent), alt('oai', 'OpenAI', [model('o1', 'o1')])],
      prompt,
      { homeProviderId: 'claude', switchOnCapacity: true },
    );
    // Quick prompt wants the small tier (Haiku, tier 2); o1 is tier 5, so the
    // switch is an upgrade the reason has to name.
    expect(pick?.switched).toBe(true);
    expect(pick?.reason).toMatch(/step up/i);
  });

  it('switches on the near-spent threshold, not only a hard limit', () => {
    const pick = pickAcrossProviders(
      [home(nearSpent), alt('or', 'OpenRouter', [model('gpt-4o-mini', 'GPT-4o mini')])],
      prompt,
      { homeProviderId: 'claude', switchOnCapacity: true },
    );
    expect(pick?.switched).toBe(true);
    expect(pick?.modelId).toBe('gpt-4o-mini');
    expect(pick?.reason).toMatch(/97% used/);
  });

  it('reads an unmeasured provider as full headroom over a partly-used one', () => {
    const pick = pickAcrossProviders(
      [home(spent7d), alt('oai', 'OpenAI', [model('gpt-5', 'GPT-5')]), alt('or', 'OpenRouter', [model('o1-pro', 'o1 pro')], headroom80)],
      'Implement and debug a distributed lock',
      { homeProviderId: 'claude', switchOnCapacity: true },
    );
    // A metered key has no capacity ceiling: 100% headroom beats a provider
    // that reports 20% used.
    expect(pick?.switched).toBe(true);
    expect(pick?.providerId).toBe('oai');
  });

  it('prefers a measured answer over an unmeasured one at equal headroom', () => {
    const fullFree: SubscriptionLimits = {
      windows: [{ id: '5h', label: '5-hour', scope: 'session', usedPercent: 0, resetAt: Date.now() + 3_600_000, status: 'allowed' }],
      updatedAt: Date.now(), staleAfterMs: 30_000,
    };
    const pick = pickAcrossProviders(
      [home(spent7d), alt('oai', 'OpenAI', [model('gpt-5', 'GPT-5')]), alt('or', 'OpenRouter', [model('o1-pro', 'o1 pro')], fullFree)],
      'Implement and debug a distributed lock',
      { homeProviderId: 'claude', switchOnCapacity: true },
    );
    // Both report 100% headroom (one assumed, one measured); the measured
    // answer wins the tie because data beats assumption.
    expect(pick?.switched).toBe(true);
    expect(pick?.providerId).toBe('or');
  });

  const apikeyHome = (models: ModelInfo[], limits?: SubscriptionLimits): ProviderPool => ({
    providerId: 'oai', providerLabel: 'OpenAI', auth: 'apikey', models, limits,
  });

  it('moves to a materially cheaper same-tier model when home is healthy', () => {
    const pick = pickAcrossProviders(
      [
        apikeyHome([model('gpt-4o', 'GPT-4o')]),
        alt('or', 'OpenRouter', [{ ...model('gpt-4o', 'GPT-4o'), inputPricePerM: 0.5, outputPricePerM: 2 }]),
      ],
      prompt,
      { homeProviderId: 'oai', switchOnCapacity: true },
    );
    // Static table blends gpt-4o at $6.25/MTok; OpenRouter publishes $1.25 for
    // the same model - a fifth of the cost at the same tier.
    expect(pick?.switched).toBe(true);
    expect(pick?.providerId).toBe('or');
    expect(pick?.reason).toMatch(/of the price/i);
  });

  it('counts a local provider as free when weighing cost', () => {
    const pick = pickAcrossProviders(
      [apikeyHome([model('gpt-4o', 'GPT-4o')]), { ...alt('local', 'Local', [model('o1-pro', 'o1 pro')]), local: true }],
      prompt,
      { homeProviderId: 'oai', switchOnCapacity: true },
    );
    expect(pick?.switched).toBe(true);
    expect(pick?.providerId).toBe('local');
    expect(pick?.reason).toMatch(/for free/i);
  });

  it('stays home when the elsewhere model is only marginally cheaper', () => {
    const pick = pickAcrossProviders(
      [apikeyHome([model('gpt-4o', 'GPT-4o')]), alt('or', 'OpenRouter', [model('gpt-4.1', 'GPT-4.1')])],
      prompt,
      { homeProviderId: 'oai', switchOnCapacity: true },
    );
    // gpt-4.1 blends $5/MTok vs gpt-4o's $6.25 - a 20% gap, under the bar.
    expect(pick?.switched).toBe(false);
    expect(pick?.providerId).toBe('oai');
  });

  it('never claims an unpriced model is cheaper', () => {
    const pick = pickAcrossProviders(
      [apikeyHome([model('gpt-4o', 'GPT-4o')]), alt('or', 'OpenRouter', [model('deepseek-r1-70b', 'DeepSeek R1 70B')])],
      prompt,
      { homeProviderId: 'oai', switchOnCapacity: true },
    );
    // The tier matches (70b ranks 5) but nothing publishes a DeepSeek price on
    // either side, so "cheaper" cannot be claimed.
    expect(pick?.switched).toBe(false);
    expect(pick?.providerId).toBe('oai');
  });

  it('prefers the cheaper of two equal-headroom candidates', () => {
    const pick = pickAcrossProviders(
      [
        apikeyHome([model('gpt-4o', 'GPT-4o')], spent7d),
        alt('dear', 'Expensive', [{ ...model('gpt-4o', 'GPT-4o'), inputPricePerM: 8, outputPricePerM: 8 }]),
        alt('cheap', 'Cheap', [{ ...model('gpt-4o', 'GPT-4o'), inputPricePerM: 1, outputPricePerM: 1 }]),
      ],
      prompt,
      { homeProviderId: 'oai', switchOnCapacity: true },
    );
    expect(pick?.switched).toBe(true);
    expect(pick?.providerId).toBe('cheap');
  });

  it('marks the home provider spent when every chat model is blocked', () => {
    const planBlocked = { ...model('claude-haiku', 'Haiku'), availability: { status: 'blocked' as const, reason: 'plan' as const } };
    const pool = home(undefined);
    pool.models = [planBlocked];
    expect(providerSwitchTrigger(pool)).toMatch(/no usable models/i);
  });

  it('reports nothing when the provider is healthy', () => {
    expect(providerSwitchTrigger(home(headroom40))).toBeNull();
  });
});
