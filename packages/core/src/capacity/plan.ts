import type {
  CapacityDevice,
  FitPlan,
  FitReason,
  FitRequest,
  HardwareFacts,
  ModelFacts,
} from '@agent-nekko/shared';
import { estimateOverheadBytes, kvCacheBytes } from './kv.js';
import { suggestFixes } from './suggest.js';

/**
 * Will this model fit, where will it run, and why.
 *
 * The planner is pure: facts in, projection out, no I/O and no clock. Everything
 * it needs is gathered by the host adapters and the GPU probes, which keeps the
 * part that has to be right exhaustively testable.
 *
 * Two rules it will not break. It never infers capacity from a model's name: a
 * missing layer count yields `unknown`, not a plausible-looking number. And it
 * never adds a unified device's memory to system RAM, because on Apple Silicon
 * they are the same bytes counted twice.
 */

/** Leftover below this and a long conversation will start evicting. */
const HEADROOM_MARGIN_BYTES = 768 * 1024 * 1024;

/** The OS needs room too; we do not get to spend the last byte of RAM. */
const OS_RESERVE_BYTES = 2 * 1024 ** 3;

export interface PlanOptions {
  /** Calibrated overhead floor, measured on this machine. */
  overheadFloorBytes?: number;
  /** Sibling models (other quantizations) we may suggest instead. */
  siblings?: ModelFacts[];
}

/**
 * The projection itself, with no suggestions attached. Split out so `suggestFixes`
 * can re-plan a candidate without recursing back into suggestion generation.
 */
export function computeFit(
  facts: ModelFacts,
  req: FitRequest,
  hw: HardwareFacts,
  opts: PlanOptions = {},
): FitPlan {
  const reasons: FitReason[] = [];
  const { device, budgetBytes, deviceTotal } = pickDevice(hw, req, reasons);

  const base = {
    deviceName: device?.name ?? null,
    deviceTotalBytes: deviceTotal,
    deviceFreeBytes: budgetBytes,
    totalLayers: facts.layers,
  };

  // 1. Metadata gate. Answering "unknown" is a feature, not a failure: a
  //    confident wrong number costs a long load and every figure's credibility
  //    after it.
  const kv = kvCacheBytes(facts, req);
  const missing = missingFields(facts, kv);
  if (missing.length > 0) {
    reasons.push({ code: 'missing-metadata', detail: missing.join(', ') });

    // Knowing the weights but not the geometry is the common LM Studio case, and
    // it is still worth something: the weights are a floor on what this needs, so
    // if they alone overflow the machine we can say "will not load" with
    // certainty. Anywhere short of that we say we cannot tell, because the KV
    // cache is the term that decides it and we do not have it.
    const knownFloor = facts.weightsBytes
      ? facts.weightsBytes + estimateOverheadBytes(facts, req, opts.overheadFloorBytes)
      : 0;
    const ceiling = hw.unified
      ? Math.max(budgetBytes, hw.systemRamFreeBytes)
      : budgetBytes + Math.max(0, hw.systemRamFreeBytes - OS_RESERVE_BYTES);
    const doomed = knownFloor > 0 && knownFloor > ceiling;
    if (doomed) reasons.push({ code: 'exceeds-total-memory', bytes: knownFloor });
    if (facts.weightsBytes && facts.weightsBytes > budgetBytes) {
      reasons.push({ code: 'weights-exceed-device', bytes: facts.weightsBytes });
    }

    return {
      ...base,
      verdict: doomed ? 'wont-load' : 'unknown',
      weightsBytes: facts.weightsBytes ?? 0,
      kvCacheBytes: kv ?? 0,
      overheadBytes: facts.weightsBytes ? estimateOverheadBytes(facts, req, opts.overheadFloorBytes) : 0,
      requiredBytes: knownFloor,
      spillBytes: 0,
      reasons,
      suggestions: [],
    };
  }

  const weights = facts.weightsBytes as number;
  const kvBytes = kv as number;
  const overhead = estimateOverheadBytes(facts, req, opts.overheadFloorBytes);
  const required = weights + kvBytes + overhead;

  const plan: FitPlan = {
    ...base,
    verdict: 'fits',
    weightsBytes: weights,
    kvCacheBytes: kvBytes,
    overheadBytes: overhead,
    requiredBytes: required,
    spillBytes: 0,
    reasons,
    suggestions: [],
  };

  // 2. A context the model itself cannot serve is a hard stop, but we still fill
  //    in the byte breakdown so the drawer can show what it would have cost.
  if (facts.maxContext && req.contextTokens > facts.maxContext) {
    reasons.push({ code: 'context-over-max', bytes: kvBytes, detail: String(facts.maxContext) });
    plan.verdict = 'wont-load';
    return plan;
  }

  // Explanatory reasons, independent of the verdict.
  if (kvBytes > weights * 0.5) {
    reasons.push({
      code: 'kv-cache-dominates',
      bytes: kvBytes,
      sharePct: pct(kvBytes, required),
    });
  }
  if (weights > budgetBytes) {
    reasons.push({ code: 'weights-exceed-device', bytes: weights });
  }

  // 3. Nothing on the machine can hold it. On a discrete setup a model can be
  //    split across VRAM and RAM, so the ceiling is both; on a unified one they
  //    are the same pool and must not be added together.
  const totalCeiling = hw.unified
    ? Math.max(budgetBytes, hw.systemRamFreeBytes)
    : budgetBytes + Math.max(0, hw.systemRamFreeBytes - OS_RESERVE_BYTES);
  if (required > totalCeiling) {
    reasons.push({ code: 'exceeds-total-memory', bytes: required });
    plan.verdict = 'wont-load';
    plan.spillBytes = required - budgetBytes;
    plan.gpuLayers = 0;
    return plan;
  }

  // 4. Fits outright, with or without comfortable headroom.
  if (required <= budgetBytes) {
    const leftover = budgetBytes - required;
    if (leftover < HEADROOM_MARGIN_BYTES) {
      reasons.push({ code: 'headroom-thin', bytes: leftover });
      plan.verdict = 'tight';
    } else {
      plan.verdict = 'fits';
    }
    plan.gpuLayers = device ? facts.layers : 0;
    return plan;
  }

  // 5. Spill. The KV cache and the runtime's own buffers are allocated first, so
  //    what is left over is what the weights get to use, and the rest of the
  //    layers run on the CPU.
  plan.verdict = 'spills';
  plan.spillBytes = required - budgetBytes;
  const weightBudget = Math.max(0, budgetBytes - kvBytes - overhead);
  const share = weights > 0 ? Math.min(1, weightBudget / weights) : 0;
  plan.gpuLayers = facts.layers ? Math.max(0, Math.min(facts.layers, Math.floor(facts.layers * share))) : undefined;
  reasons.push({ code: 'partial-offload', bytes: plan.spillBytes, sharePct: pct(plan.spillBytes, required) });
  return plan;
}

/**
 * The public entry point: a projection with the fixes that would improve it.
 * Each suggestion is re-planned before it is offered, so a chip never proposes a
 * change that would not actually help.
 */
export function planFit(
  facts: ModelFacts,
  req: FitRequest,
  hw: HardwareFacts,
  opts: PlanOptions = {},
): FitPlan {
  const plan = computeFit(facts, req, hw, opts);
  plan.suggestions = suggestFixes(facts, req, plan, opts, (candidate) =>
    computeFit(facts, candidate, hw, opts),
  );
  return plan;
}

/** Which single pool this plan is measured against. Devices are not pooled. */
function pickDevice(
  hw: HardwareFacts,
  req: FitRequest,
  reasons: FitReason[],
): { device: CapacityDevice | null; budgetBytes: number; deviceTotal: number } {
  if (hw.devices.length === 0) {
    reasons.push({ code: 'no-gpu' });
    const budget = Math.max(0, hw.systemRamFreeBytes - OS_RESERVE_BYTES);
    return { device: null, budgetBytes: budget, deviceTotal: hw.systemRamTotalBytes };
  }

  // Without tensor parallelism a model must fit on one device, so we plan against
  // the roomiest rather than the sum. Saying so is the honest part.
  if (hw.devices.length > 1 && !hw.unified) {
    reasons.push({ code: 'multi-device-not-pooled', detail: String(hw.devices.length) });
  }
  if (hw.unified) {
    reasons.push({ code: 'unified-memory' });
  }

  const device = hw.devices.reduce((best, d) => (d.freeBytes > best.freeBytes ? d : best));
  const fraction = clamp01(req.gpuLayerFraction);
  return {
    device,
    budgetBytes: Math.max(0, device.freeBytes * fraction),
    deviceTotal: device.totalBytes,
  };
}

/** Fields the projection cannot be computed without. */
function missingFields(facts: ModelFacts, kv: number | null): string[] {
  const missing: string[] = [];
  if (!facts.weightsBytes) missing.push('weights size');
  if (kv === null) {
    if (!facts.layers) missing.push('layer count');
    if (!facts.kvHeads) missing.push('KV head count');
    if (!facts.headDim) missing.push('head dimension');
  }
  return missing;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}
