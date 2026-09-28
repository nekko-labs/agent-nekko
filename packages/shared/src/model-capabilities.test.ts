import { describe, expect, it } from 'vitest';
import {
  claudeContextWindow,
  effectiveEffort,
  modelDefaultEffort,
  modelEffortLevels,
  parseClaudeModel,
  usesNativeEffort,
} from './model-capabilities.js';

describe('parseClaudeModel', () => {
  it('reads family and version, ignoring a vendor prefix and a date suffix', () => {
    expect(parseClaudeModel('anthropic/claude-opus-5-5')).toEqual({ family: 'opus', major: 5, minor: 5 });
    expect(parseClaudeModel('claude-haiku-4-5-20251001')).toEqual({ family: 'haiku', major: 4, minor: 5 });
    // A bare date is not a minor version.
    expect(parseClaudeModel('claude-opus-4-20250514')).toEqual({ family: 'opus', major: 4, minor: 0 });
    expect(parseClaudeModel('gpt-5')).toBeNull();
  });
});

describe('claudeContextWindow', () => {
  it('gives every current model 1M and Haiku 200k', () => {
    for (const id of ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5-1']) {
      expect(claudeContextWindow(id)).toBe(1_000_000);
    }
    expect(claudeContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(claudeContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(claudeContextWindow('llama3')).toBeUndefined();
  });
});

describe('effort capability', () => {
  it('offers the five Anthropic rungs only where the model takes an effort level', () => {
    expect(modelEffortLevels('claude-opus-5-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(modelEffortLevels('claude-fable-5-1')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    // 4.6 and Haiku still sample, so they get the temperature scale.
    expect(usesNativeEffort('claude-sonnet-4-6')).toBe(false);
    expect(modelEffortLevels('claude-haiku-4-5')).toEqual(['low', 'normal', 'high']);
    expect(modelEffortLevels('gpt-5')).toEqual(['low', 'normal', 'high']);
  });

  it('knows Opus 5.5 defaults to medium, not high', () => {
    expect(modelDefaultEffort('claude-opus-5-5')).toBe('medium');
    expect(modelDefaultEffort('claude-opus-5')).toBe('high');
    expect(effectiveEffort('normal', 'claude-opus-5-5')).toBe('medium');
    expect(effectiveEffort(undefined, 'claude-opus-5')).toBe('high');
  });

  it('maps a saved rung the model lacks to the nearest one it has', () => {
    expect(effectiveEffort('xhigh', 'gpt-5')).toBe('high');
    expect(effectiveEffort('medium', 'gpt-5')).toBe('normal');
    expect(effectiveEffort('xhigh', 'claude-opus-5')).toBe('xhigh');
  });
});
