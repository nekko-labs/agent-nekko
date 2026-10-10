import { describe, expect, it } from 'vitest';
import type { HardwareFacts, ModelFacts, FitRequest } from '@agent-nekko/shared';
import { planFit } from './plan.js';

const GB = 1024 ** 3;

const llama8b: ModelFacts = {
  id: 'llama3.1:8b',
  providerId: 'p1',
  weightsBytes: 4.9 * GB,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContext: 131072,
};

const req: FitRequest = { contextTokens: 8192, parallelSlots: 1, kvCacheDtype: 'f16', gpuLayerFraction: 1 };

const rtx4090: HardwareFacts = {
  devices: [{ name: 'RTX 4090', totalBytes: 24 * GB, freeBytes: 23 * GB }],
  unified: false,
  systemRamTotalBytes: 64 * GB,
  systemRamFreeBytes: 40 * GB,
};

const macM3: HardwareFacts = {
  devices: [{ name: 'Apple M3 Max', totalBytes: 36 * GB, freeBytes: 22 * GB }],
  unified: true,
  systemRamTotalBytes: 36 * GB,
  systemRamFreeBytes: 22 * GB,
};

const cpuOnly: HardwareFacts = {
  devices: [],
  unified: false,
  systemRamTotalBytes: 16 * GB,
  systemRamFreeBytes: 12 * GB,
};

const codes = (p: ReturnType<typeof planFit>) => p.reasons.map((r) => r.code);

describe('planFit', () => {
  it('fits a small model on a big card, and the parts add up to the whole', () => {
    const plan = planFit(llama8b, req, rtx4090);
    expect(plan.verdict).toBe('fits');
    expect(plan.deviceName).toBe('RTX 4090');
    expect(plan.spillBytes).toBe(0);
    expect(plan.requiredBytes).toBe(plan.weightsBytes + plan.kvCacheBytes + plan.overheadBytes);
  });

  // 8B at full 128k really does fit on a 24 GB card (16 GB of KV plus 5 GB of
  // weights), so a genuine spill needs a second concurrent slot to double the KV.
  it('spills when context and parallelism together blow past the card', () => {
    const plan = planFit(llama8b, { ...req, contextTokens: 131072, parallelSlots: 2 }, rtx4090);
    expect(plan.verdict).toBe('spills');
    expect(plan.spillBytes).toBeGreaterThan(0);
    expect(codes(plan)).toContain('kv-cache-dominates');
    expect(codes(plan)).toContain('partial-offload');
  });

  it('reports unknown rather than guessing when geometry is missing', () => {
    const plan = planFit({ id: 'mystery', providerId: 'p1', weightsBytes: 5 * GB }, req, rtx4090);
    expect(plan.verdict).toBe('unknown');
    expect(codes(plan)).toContain('missing-metadata');
  });

  it('reports unknown when the weights size is missing too', () => {
    const plan = planFit({ ...llama8b, weightsBytes: undefined }, req, rtx4090);
    expect(plan.verdict).toBe('unknown');
    expect(plan.reasons.find((r) => r.code === 'missing-metadata')?.detail).toContain('weights');
  });

  it('never adds unified GPU memory on top of system RAM', () => {
    const plan = planFit(llama8b, req, macM3);
    expect(plan.deviceTotalBytes).toBe(36 * GB);
    expect(codes(plan)).toContain('unified-memory');
    // The budget is the one pool, not the pool plus RAM.
    expect(plan.deviceFreeBytes).toBeLessThanOrEqual(macM3.systemRamTotalBytes);
  });

  it('measures against system RAM on a machine with no GPU, and offloads nothing', () => {
    const plan = planFit(llama8b, req, cpuOnly);
    expect(plan.deviceName).toBeNull();
    // It genuinely fits in RAM and will run, slowly. Calling that a "spill" would
    // be wrong: there is no VRAM to spill out of. The no-gpu reason is what tells
    // the UI to say it runs on the CPU.
    expect(plan.verdict).toBe('fits');
    expect(codes(plan)).toContain('no-gpu');
    expect(plan.gpuLayers).toBe(0);
  });

  it('will not load a model that overflows a CPU-only machine', () => {
    const plan = planFit({ ...llama8b, weightsBytes: 30 * GB }, req, cpuOnly);
    expect(plan.verdict).toBe('wont-load');
  });

  it('refuses a context above the model maximum', () => {
    const plan = planFit(llama8b, { ...req, contextTokens: 200_000 }, rtx4090);
    expect(plan.verdict).toBe('wont-load');
    expect(codes(plan)).toContain('context-over-max');
  });

  it('will not load when even system RAM cannot hold it', () => {
    const huge: ModelFacts = { ...llama8b, weightsBytes: 400 * GB };
    const plan = planFit(huge, req, rtx4090);
    expect(plan.verdict).toBe('wont-load');
    expect(codes(plan)).toContain('exceeds-total-memory');
  });

  it('does not pool two discrete cards', () => {
    const dual: HardwareFacts = {
      devices: [
        { name: 'A', totalBytes: 12 * GB, freeBytes: 12 * GB },
        { name: 'B', totalBytes: 12 * GB, freeBytes: 12 * GB },
      ],
      unified: false,
      systemRamTotalBytes: 64 * GB,
      systemRamFreeBytes: 40 * GB,
    };
    const plan = planFit({ ...llama8b, weightsBytes: 20 * GB }, req, dual);
    expect(plan.deviceTotalBytes).toBe(12 * GB);
    expect(codes(plan)).toContain('multi-device-not-pooled');
    expect(codes(plan)).toContain('weights-exceed-device');
  });

  it('counts free memory, not total, when something is already resident', () => {
    const busy: HardwareFacts = {
      devices: [{ name: 'RTX 4090', totalBytes: 24 * GB, freeBytes: 4 * GB }],
      unified: false,
      systemRamTotalBytes: 64 * GB,
      systemRamFreeBytes: 40 * GB,
    };
    expect(planFit(llama8b, req, busy).verdict).toBe('spills');
  });

  it('flags a fit with thin headroom as tight', () => {
    const snug: HardwareFacts = {
      devices: [{ name: 'RTX 3060', totalBytes: 12 * GB, freeBytes: 5.5 * GB }],
      unified: false,
      systemRamTotalBytes: 32 * GB,
      systemRamFreeBytes: 20 * GB,
    };
    const plan = planFit(llama8b, { ...req, contextTokens: 2048 }, snug);
    expect(plan.verdict).toBe('tight');
    expect(codes(plan)).toContain('headroom-thin');
  });

  it('estimates how many layers land on the GPU when it spills', () => {
    const plan = planFit(llama8b, { ...req, contextTokens: 131072, parallelSlots: 2 }, rtx4090);
    expect(plan.totalLayers).toBe(32);
    expect(plan.gpuLayers).toBeGreaterThanOrEqual(0);
    expect(plan.gpuLayers).toBeLessThan(32);
  });

  it('honours a partial GPU layer fraction as a smaller budget', () => {
    const full = planFit(llama8b, req, rtx4090);
    const half = planFit(llama8b, { ...req, gpuLayerFraction: 0.2 }, rtx4090);
    expect(full.verdict).toBe('fits');
    expect(half.verdict).toBe('spills');
  });

  it('multiplies the KV cost by parallel slots, all the way to a spill', () => {
    const one = planFit(llama8b, { ...req, contextTokens: 32768 }, rtx4090);
    const eight = planFit(llama8b, { ...req, contextTokens: 32768, parallelSlots: 8 }, rtx4090);
    expect(one.verdict).toBe('fits');
    expect(eight.kvCacheBytes).toBe(one.kvCacheBytes * 8);
    expect(eight.verdict).toBe('spills');
  });
});

describe('planFit with partial metadata', () => {
  // The common LM Studio case: the CLI catalogue gives a real weights size, but
  // neither its API nor its CLI publishes layer geometry.
  const weightsOnly: ModelFacts = {
    id: 'qwen/qwen3.8-27b',
    providerId: 'p1',
    weightsBytes: 29.5 * GB,
    maxContext: 262144,
    quantization: '8bit',
  };

  it('still says will-not-load when the weights alone overflow the machine', () => {
    const small: HardwareFacts = {
      devices: [{ name: 'RTX 3060', totalBytes: 12 * GB, freeBytes: 11 * GB }],
      unified: false,
      systemRamTotalBytes: 16 * GB,
      systemRamFreeBytes: 8 * GB,
    };
    const plan = planFit(weightsOnly, req, small);
    expect(plan.verdict).toBe('wont-load');
    expect(codes(plan)).toContain('exceeds-total-memory');
  });

  it('says it cannot tell when the weights fit but the KV cache is unknown', () => {
    const plan = planFit(weightsOnly, req, rtx4090);
    expect(plan.verdict).toBe('unknown');
    expect(codes(plan)).toContain('missing-metadata');
    // The weights are still real and worth showing.
    expect(plan.weightsBytes).toBe(29.5 * GB);
    expect(plan.requiredBytes).toBeGreaterThan(29.5 * GB);
  });

  it('flags weights larger than the card even while the verdict is unknown', () => {
    const plan = planFit(weightsOnly, req, rtx4090);
    expect(codes(plan)).toContain('weights-exceed-device');
  });
});
