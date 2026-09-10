import { describe, it, expect } from 'vitest';
import { recommendModel, pickAutoModel, isComplexPrompt, modelTier } from '@agent-nekko/shared';
import type { ModelInfo } from '@agent-nekko/shared';

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
