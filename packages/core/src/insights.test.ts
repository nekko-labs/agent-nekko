import { describe, it, expect } from 'vitest';
import { optimizationTips } from '@agent-nekko/shared';
import type { InsightsInput, Session, UsageSummary, ProviderConfig } from '@agent-nekko/shared';

function session(id: string, modelId: string, msgCount: number): Session {
  return {
    id,
    title: id,
    modelId,
    messages: Array.from({ length: msgCount }, (_, i) => ({
      id: `${id}-m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x',
      createdAt: 0,
    })),
    createdAt: 0,
    updatedAt: 0,
  };
}

const cloudProvider: ProviderConfig = { id: 'anth', kind: 'anthropic', label: 'Anthropic', baseUrl: '', enabled: true };
const localProvider: ProviderConfig = { id: 'lm', kind: 'lmstudio', label: 'LM Studio', baseUrl: '', enabled: true };

function usage(partial: Partial<UsageSummary>): UsageSummary {
  return {
    totalInput: 0,
    totalOutput: 0,
    byModel: {},
    byProvider: {},
    bySession: {},
    daily: [],
    ...partial,
  };
}

describe('optimizationTips', () => {
  it('returns nothing without usage', () => {
    expect(optimizationTips({ usage: null, sessions: [], providers: [] })).toEqual([]);
  });

  it('suggests local routing when a local provider exists and there is cloud spend', () => {
    const input: InsightsInput = {
      usage: usage({ byModel: { 'claude-opus': { input: 1_000_000, output: 200_000 } } }),
      sessions: [],
      providers: [cloudProvider, localProvider],
    };
    const tips = optimizationTips(input);
    expect(tips.some((t) => t.id === 'use-local')).toBe(true);
  });

  it('does NOT suggest local routing when no local provider is connected', () => {
    const input: InsightsInput = {
      usage: usage({ byModel: { 'claude-opus': { input: 1_000_000, output: 200_000 } } }),
      sessions: [],
      providers: [cloudProvider],
    };
    expect(optimizationTips(input).some((t) => t.id === 'use-local')).toBe(false);
  });

  it('flags short chats on an expensive model', () => {
    const s1 = session('s1', 'claude-opus', 2);
    const s2 = session('s2', 'claude-opus', 4);
    const input: InsightsInput = {
      usage: usage({
        bySession: {
          s1: { input: 50_000, output: 5_000 }, // ~$1.13 → > $0.02
          s2: { input: 40_000, output: 4_000 },
        },
      }),
      sessions: [s1, s2],
      providers: [cloudProvider],
    };
    const tip = optimizationTips(input).find((t) => t.id === 'cheaper-for-short');
    expect(tip).toBeTruthy();
    expect(tip!.detail).toContain('Haiku'); // opus → suggest Sonnet or Haiku
    expect(tip!.saving).toBeGreaterThan(0);
  });

  it('warns when input dwarfs output', () => {
    const input: InsightsInput = {
      usage: usage({ totalInput: 600_000, totalOutput: 10_000 }),
      sessions: [],
      providers: [cloudProvider],
    };
    expect(optimizationTips(input).some((t) => t.id === 'prune-context')).toBe(true);
  });

  it('orders warnings before suggestions and respects the limit', () => {
    const s1 = session('s1', 'claude-opus', 2);
    const input: InsightsInput = {
      usage: usage({
        totalInput: 600_000,
        totalOutput: 10_000,
        byModel: { 'claude-opus': { input: 600_000, output: 10_000 } },
        bySession: { s1: { input: 60_000, output: 1_000 } },
      }),
      sessions: [s1, session('s2', 'claude-opus', 3)],
      providers: [cloudProvider, localProvider],
    };
    const tips = optimizationTips(input, 2);
    expect(tips.length).toBeLessThanOrEqual(2);
    expect(tips[0].severity).toBe('warn');
  });
});
