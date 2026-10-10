import { describe, it, expect } from 'vitest';
import {
  getStrategy,
  orchestrationPromptHint,
  ORCHESTRATION_STRATEGIES,
  DEFAULT_ORCHESTRATION,
} from '@agent-nekko/shared';

describe('getStrategy', () => {
  it('falls back to balanced for unknown/undefined ids', () => {
    expect(getStrategy(undefined).id).toBe('balanced');
    // @ts-expect-error testing an invalid id at runtime
    expect(getStrategy('nope').id).toBe('balanced');
  });

  it('solo disallows spawning; balanced and swarm allow it', () => {
    expect(getStrategy('solo').allowsSpawn).toBe(false);
    expect(getStrategy('balanced').allowsSpawn).toBe(true);
    expect(getStrategy('swarm').allowsSpawn).toBe(true);
  });
});

describe('orchestrationPromptHint', () => {
  it('is empty for solo (no delegation)', () => {
    expect(orchestrationPromptHint({ strategy: 'solo', maxDepth: 2, maxParallel: 4 })).toBe('');
  });

  it('includes the bounds for delegating strategies', () => {
    const hint = orchestrationPromptHint({ strategy: 'swarm', maxDepth: 3, maxParallel: 6 });
    expect(hint).toContain('orchestrator');
    expect(hint).toContain('6');
    expect(hint).toContain('3 levels');
  });

  it('singularizes a depth of 1', () => {
    const hint = orchestrationPromptHint({ strategy: 'balanced', maxDepth: 1, maxParallel: 2 });
    expect(hint).toContain('1 level');
    expect(hint).not.toContain('1 levels');
  });
});

describe('defaults & catalog', () => {
  it('the default strategy exists in the catalog', () => {
    expect(ORCHESTRATION_STRATEGIES.some((s) => s.id === DEFAULT_ORCHESTRATION.strategy)).toBe(true);
  });

  it('only allowsSpawn strategies carry a prompt hint', () => {
    for (const s of ORCHESTRATION_STRATEGIES) {
      if (!s.allowsSpawn) expect(s.promptHint).toBe('');
      else expect(s.promptHint.length).toBeGreaterThan(0);
    }
  });
});
