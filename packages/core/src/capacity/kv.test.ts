import { describe, expect, it } from 'vitest';
import type { ModelFacts, FitRequest } from '@agent-nekko/shared';
import { kvCacheBytes, estimateOverheadBytes, headDimOf } from './kv.js';

const llama8b: ModelFacts = {
  id: 'llama3.1:8b',
  providerId: 'p1',
  weightsBytes: 4_920_000_000,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContext: 131072,
  quantization: 'Q4_K_M',
};

const req: FitRequest = { contextTokens: 8192, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 };

describe('kvCacheBytes', () => {
  it('computes 2 x layers x kvHeads x headDim x context x bytes x slots', () => {
    // 2 * 32 * 8 * 128 * 8192 * 2 * 1
    expect(kvCacheBytes(llama8b, req)).toBe(1_073_741_824);
  });

  it('multiplies by parallel slots, which is the whole point', () => {
    expect(kvCacheBytes(llama8b, { ...req, parallelSlots: 4 })).toBe(4 * 1_073_741_824);
  });

  it('halves for a q8_0 cache and quarters for q4_0', () => {
    expect(kvCacheBytes(llama8b, { ...req, kvCacheDtype: 'q8_0' })).toBe(1_073_741_824 / 2);
    expect(kvCacheBytes(llama8b, { ...req, kvCacheDtype: 'q4_0' })).toBe(1_073_741_824 / 4);
  });

  it('returns null when the model geometry is unknown', () => {
    expect(kvCacheBytes({ id: 'x', providerId: 'p1', weightsBytes: 1 }, req)).toBeNull();
    expect(kvCacheBytes({ ...llama8b, kvHeads: undefined }, req)).toBeNull();
    expect(kvCacheBytes({ ...llama8b, layers: undefined }, req)).toBeNull();
    expect(kvCacheBytes({ ...llama8b, headDim: undefined }, req)).toBeNull();
  });

  it('treats a zero or negative slot count as one slot', () => {
    expect(kvCacheBytes(llama8b, { ...req, parallelSlots: 0 })).toBe(1_073_741_824);
    expect(kvCacheBytes(llama8b, { ...req, parallelSlots: -3 })).toBe(1_073_741_824);
  });

  it('is zero at zero context rather than negative', () => {
    expect(kvCacheBytes(llama8b, { ...req, contextTokens: -1 })).toBe(0);
  });
});

describe('estimateOverheadBytes', () => {
  it('scales with context and never drops below the floor', () => {
    const small = estimateOverheadBytes(llama8b, { ...req, contextTokens: 512 });
    const large = estimateOverheadBytes(llama8b, { ...req, contextTokens: 131072 });
    expect(small).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    expect(large).toBeGreaterThan(small);
  });

  it('honours a calibrated floor measured on this machine', () => {
    expect(estimateOverheadBytes(llama8b, req, 900_000_000)).toBeGreaterThanOrEqual(900_000_000);
  });

  it('still produces a number for a model with no known geometry', () => {
    expect(estimateOverheadBytes({ id: 'x', providerId: 'p1' }, req)).toBeGreaterThan(0);
  });
});

describe('headDimOf', () => {
  it('divides embedding length by head count', () => {
    expect(headDimOf(4096, 32)).toBe(128);
    expect(headDimOf(5120, 40)).toBe(128);
  });

  it('is undefined when either input is missing or nonsense', () => {
    expect(headDimOf(undefined, 32)).toBeUndefined();
    expect(headDimOf(4096, undefined)).toBeUndefined();
    expect(headDimOf(4096, 0)).toBeUndefined();
  });
});
