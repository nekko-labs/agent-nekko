import { describe, expect, it } from 'vitest';
import type { HardwareFacts, ModelFacts } from '@agent-nekko/shared';
import { autoFit } from './autofit.js';

/**
 * The simple surface is a solver, and a solver that quietly proposes something
 * that will not fit is worse than no solver. These tests pin the three things it
 * must never do: exceed the budget it was given, invent settings for a model
 * whose geometry is unknown, and double-count unified memory.
 */

const GB = 1024 ** 3;

/** An 8B-class model with complete geometry: ~4.7 GB of Q4 weights. */
const model = (over: Partial<ModelFacts> = {}): ModelFacts => ({
  id: 'qwen3-8b',
  providerId: 'engine',
  weightsBytes: 4.7 * GB,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContext: 131072,
  quantization: 'Q4_K_M',
  ...over,
});

const discrete = (freeGb: number, totalGb = freeGb): HardwareFacts => ({
  devices: [{ name: 'RTX 5090', totalBytes: totalGb * GB, freeBytes: freeGb * GB }],
  unified: false,
  systemRamTotalBytes: 64 * GB,
  systemRamFreeBytes: 40 * GB,
});

describe('autoFit', () => {
  it('stays inside the budget it was given', () => {
    const hw = discrete(32);
    const half = autoFit({ facts: model(), hardware: hw, budgetFraction: 0.5 });
    // Half of 32 GB free is the ceiling, and the projection has to land under it.
    expect(half.plan.requiredBytes).toBeLessThanOrEqual(16 * GB);
    expect(['fits', 'tight']).toContain(half.plan.verdict);
  });

  it('spends a larger budget on a larger context', () => {
    const hw = discrete(32);
    const small = autoFit({ facts: model(), hardware: hw, budgetFraction: 0.3 });
    const large = autoFit({ facts: model(), hardware: hw, budgetFraction: 0.95 });
    expect(large.request.contextTokens).toBeGreaterThan(small.request.contextTokens);
  });

  it('never proposes more context than the model supports', () => {
    const result = autoFit({
      facts: model({ maxContext: 8192 }),
      hardware: discrete(80),
      budgetFraction: 0.95,
    });
    expect(result.request.contextTokens).toBeLessThanOrEqual(8192);
  });

  it('respects an explicit context ceiling', () => {
    const result = autoFit({
      facts: model(),
      hardware: discrete(80),
      budgetFraction: 0.95,
      maxContextTokens: 16384,
    });
    expect(result.request.contextTokens).toBeLessThanOrEqual(16384);
  });

  it('gives up KV precision before giving up on the model', () => {
    // A budget that cannot hold the f16 cache at any offered context still has an
    // answer at q8_0, and says that is what it did.
    const result = autoFit({ facts: model(), hardware: discrete(6), budgetFraction: 0.95 });
    expect(result.request.kvCacheDtype).toBe('q8_0');
    expect(result.compromises.join(' ')).toContain('q8_0');
  });

  it('accounts for parallel slots multiplying the cache', () => {
    const hw = discrete(24);
    const single = autoFit({ facts: model(), hardware: hw, budgetFraction: 0.9, parallelSlots: 1 });
    const four = autoFit({ facts: model(), hardware: hw, budgetFraction: 0.9, parallelSlots: 4 });
    expect(four.request.parallelSlots).toBe(4);
    expect(four.request.contextTokens).toBeLessThan(single.request.contextTokens);
  });

  it('answers unknown, with no settings invented, when the geometry is missing', () => {
    const result = autoFit({
      facts: model({ layers: undefined, kvHeads: undefined, headDim: undefined }),
      hardware: discrete(32),
      budgetFraction: 0.75,
    });
    expect(result.plan.verdict).toBe('unknown');
    expect(result.headline).toMatch(/cannot tell/i);
    expect(result.compromises).toEqual([]);
  });

  it('does not add a unified device to system RAM', () => {
    const mac: HardwareFacts = {
      devices: [{ name: 'Apple M1 Max', totalBytes: 64 * GB, freeBytes: 40 * GB }],
      unified: true,
      systemRamTotalBytes: 64 * GB,
      systemRamFreeBytes: 40 * GB,
    };
    const result = autoFit({ facts: model(), hardware: mac, budgetFraction: 0.5 });
    // Half of one 40 GB pool is 20 GB, not half of 80.
    expect(result.plan.deviceFreeBytes).toBeCloseTo(20 * GB, -8);
    expect(result.plan.requiredBytes).toBeLessThanOrEqual(20 * GB);
  });

  it('falls back to partial offload instead of refusing to answer', () => {
    const result = autoFit({ facts: model({ weightsBytes: 40 * GB }), hardware: discrete(8), budgetFraction: 0.9 });
    expect(['spills', 'wont-load']).toContain(result.plan.verdict);
    expect(result.compromises.length).toBeGreaterThan(0);
  });

  it('describes the cost in memory, never in tokens per second', () => {
    const result = autoFit({ facts: model(), hardware: discrete(32), budgetFraction: 0.75 });
    expect(result.tradeoff).toMatch(/GB|MB/);
    expect(`${result.headline} ${result.tradeoff}`).not.toMatch(/tok\/s|tokens per second/i);
  });

  it('clamps an out-of-range budget rather than producing nonsense', () => {
    const hw = discrete(32);
    for (const fraction of [0, -1, 5, Number.NaN]) {
      const result = autoFit({ facts: model(), hardware: hw, budgetFraction: fraction });
      expect(result.plan.requiredBytes).toBeGreaterThan(0);
      expect(result.request.contextTokens).toBeGreaterThan(0);
    }
  });

  it('plans against system memory on a machine with no GPU', () => {
    const cpuOnly: HardwareFacts = {
      devices: [],
      unified: false,
      systemRamTotalBytes: 32 * GB,
      systemRamFreeBytes: 24 * GB,
    };
    const result = autoFit({ facts: model(), hardware: cpuOnly, budgetFraction: 0.75 });
    expect(result.plan.deviceName).toBeNull();
    expect(result.headline).toContain('CPU');
  });
});
