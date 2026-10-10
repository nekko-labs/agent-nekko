import { describe, expect, it } from 'vitest';
import type { HardwareFacts, ModelFacts, FitRequest } from '@agent-nekko/shared';
import { planFit } from './plan.js';

const GB = 1024 ** 3;

const model: ModelFacts = {
  id: 'llama3.1:8b',
  providerId: 'p1',
  weightsBytes: 4.9 * GB,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContext: 131072,
};

const hw: HardwareFacts = {
  devices: [{ name: 'RTX 4090', totalBytes: 24 * GB, freeBytes: 23 * GB }],
  unified: false,
  systemRamTotalBytes: 64 * GB,
  systemRamFreeBytes: 40 * GB,
};

// A request that genuinely does not fit: 128k of context across two concurrent
// slots is 34 GB of KV cache on a card holding 23 GB.
const req: FitRequest = { contextTokens: 131072, parallelSlots: 2, kvCacheDtype: 'f16', gpuLayerFraction: 1 };

describe('suggestions', () => {
  it('offers a context that actually fits, and applying it does fit', () => {
    const plan = planFit(model, req, hw);
    const ctx = plan.suggestions.find((s) => s.apply?.contextTokens);
    expect(ctx).toBeTruthy();
    const applied = planFit(model, { ...req, ...ctx!.apply }, hw);
    expect(['fits', 'tight']).toContain(applied.verdict);
  });

  it('offers a cheaper KV cache with the bytes it saves', () => {
    const plan = planFit(model, req, hw);
    const kv = plan.suggestions.find((s) => s.apply?.kvCacheDtype === 'q8_0');
    expect(kv?.savesBytes).toBeGreaterThan(0);
  });

  it('offers to cut parallel slots only when there is more than one', () => {
    const single = planFit(model, { ...req, parallelSlots: 1 }, hw);
    expect(single.suggestions.some((s) => s.apply?.parallelSlots)).toBe(false);

    const slots = planFit(model, req, hw).suggestions.find((s) => s.apply?.parallelSlots);
    expect(slots?.apply?.parallelSlots).toBeLessThan(req.parallelSlots);
  });

  it('suggests nothing when the model already fits', () => {
    expect(planFit(model, { ...req, contextTokens: 4096, parallelSlots: 1 }, hw).suggestions).toHaveLength(0);
  });

  it('suggests nothing when we cannot tell, rather than guessing', () => {
    const mystery: ModelFacts = { id: 'x', providerId: 'p1' };
    const plan = planFit(mystery, req, hw);
    expect(plan.verdict).toBe('unknown');
    expect(plan.suggestions).toHaveLength(0);
  });

  it('caps the list at three so the drawer stays readable', () => {
    const siblings: ModelFacts[] = [{ ...model, id: 'llama3.1:8b-q4', weightsBytes: 2.5 * GB }];
    const plan = planFit(model, { ...req, parallelSlots: 4 }, hw, { siblings });
    expect(plan.suggestions.length).toBeLessThanOrEqual(3);
  });

  it('offers a smaller sibling build when one would fit', () => {
    const siblings: ModelFacts[] = [
      { ...model, id: 'llama3.1:8b-q4', weightsBytes: 2.5 * GB },
      { ...model, id: 'llama3.1:70b', weightsBytes: 40 * GB },
    ];
    const tightHw: HardwareFacts = {
      devices: [{ name: 'RTX 3060', totalBytes: 12 * GB, freeBytes: 5 * GB }],
      unified: false,
      systemRamTotalBytes: 32 * GB,
      systemRamFreeBytes: 20 * GB,
    };
    const plan = planFit(model, { ...req, contextTokens: 8192, parallelSlots: 1 }, tightHw, { siblings });
    const alt = plan.suggestions.find((s) => s.alternateModelId);
    expect(alt?.alternateModelId).toBe('llama3.1:8b-q4');
  });

  it('caps a context suggestion at the model maximum when the request was over it', () => {
    const plan = planFit(model, { ...req, contextTokens: 400_000 }, hw);
    const ctx = plan.suggestions.find((s) => s.apply?.contextTokens);
    expect(ctx?.apply?.contextTokens).toBeLessThanOrEqual(131072);
  });

  it('never suggests a change that leaves the verdict no better', () => {
    // A model far too large for the machine: no context or cache tweak rescues it.
    const huge: ModelFacts = { ...model, weightsBytes: 400 * GB };
    for (const s of planFit(huge, req, hw).suggestions) {
      const applied = planFit(huge, { ...req, ...s.apply }, hw);
      expect(applied.verdict).not.toBe('wont-load');
    }
  });
});
