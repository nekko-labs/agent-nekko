import {
  DEFAULT_FIT_REQUEST,
  type AutoFitSummary,
  type FitPlan,
  type FitRequest,
  type HardwareFacts,
  type KvCacheDtype,
  type ModelFacts,
} from '@agent-nekko/shared';
import { computeFit, type PlanOptions } from './plan.js';

/**
 * The simple surface, solved.
 *
 * The advanced surface asks a user to choose a context length, a KV cache type
 * and a GPU offload share. The simple surface asks one question, "how much of
 * this machine may it use", and this is what turns that answer into the other
 * three. It is the same planner underneath: the budget scales the machine's free
 * memory, and we search for the best settings that fit inside it.
 *
 * Context and quantization trade against each other in one pool, so they are
 * solved together rather than in sequence. The search is deliberately coarse
 * (context stops, then a cheaper KV cache, then partial offload) because the
 * inputs are estimates and a finer search would imply a precision we do not have.
 *
 * It keeps the planner's honesty rules, because it is the planner: a model whose
 * geometry we do not know comes back `unknown` with no settings invented for it.
 */

/** The context ladder, descending. Anything below 2k is not worth offering. */
const CONTEXT_STOPS = [131072, 65536, 32768, 16384, 8192, 4096, 2048];

/** Tried in order, so full precision is only given up when it has to be. */
const KV_LADDER: KvCacheDtype[] = ['f16', 'q8_0'];

export interface AutoFitInput {
  facts: ModelFacts;
  hardware: HardwareFacts;
  /** 0..1 share of free memory the model may occupy. */
  budgetFraction: number;
  /** Concurrent slots to plan for. Each gets its own full KV cache. */
  parallelSlots?: number;
  /** Never propose more context than this (a user's explicit ceiling). */
  maxContextTokens?: number;
  options?: PlanOptions;
}

/** The shape travels over IPC, so it is defined once in shared. */
export type AutoFitResult = AutoFitSummary;

export function autoFit(input: AutoFitInput): AutoFitResult {
  const { facts, hardware } = input;
  const fraction = clamp(input.budgetFraction, 0.1, 1);
  const slots = Math.max(1, input.parallelSlots ?? 1);
  const budgetHw = scaleHardware(hardware, fraction);

  const ceiling = Math.min(
    input.maxContextTokens ?? Number.POSITIVE_INFINITY,
    facts.maxContext ?? Number.POSITIVE_INFINITY,
  );
  const stops = CONTEXT_STOPS.filter((c) => c <= ceiling);
  // A model whose own maximum is below every stop still deserves an answer.
  if (stops.length === 0 && Number.isFinite(ceiling)) stops.push(Math.max(512, Math.floor(ceiling)));

  const compromises: string[] = [];
  let best: { request: FitRequest; plan: FitPlan } | null = null;

  // Context is the outer loop and precision the inner one, which encodes the
  // trade this makes on the user's behalf: keep the longer conversation and pay
  // for it with a cheaper KV element, rather than keep full-precision attention
  // and hand back a 2k window. Within one context, f16 is still tried first, so
  // precision is only given up where it actually buys something.
  outer: for (const contextTokens of stops) {
    for (const kvCacheDtype of KV_LADDER) {
      const request: FitRequest = {
        ...DEFAULT_FIT_REQUEST,
        contextTokens,
        parallelSlots: slots,
        kvCacheDtype,
        gpuLayerFraction: 1,
      };
      const plan = computeFit(facts, request, budgetHw, input.options);

      // Nothing to search for: without the geometry every candidate is the same
      // `unknown`, so report the first one rather than pretending to have chosen.
      if (plan.verdict === 'unknown') {
        return unknownResult(request, plan);
      }
      if (plan.verdict === 'fits' || plan.verdict === 'tight') {
        best = { request, plan };
        break outer;
      }
    }
  }

  if (best) {
    if (best.request.kvCacheDtype !== 'f16') {
      compromises.push('Used a smaller KV cache element (q8_0) to keep this much context.');
    }
    if (stops.length > 0 && best.request.contextTokens < stops[0]) {
      compromises.push(
        `Context is ${formatTokens(best.request.contextTokens)} rather than the model's ${formatTokens(stops[0])}, which would not fit in this budget.`,
      );
    }
  }

  // Nothing fits entirely in the budget. Offer the smallest sensible context with
  // partial offload rather than refusing: a spilled model still runs, and saying
  // so plainly is more useful than an empty answer.
  if (!best) {
    const request: FitRequest = {
      ...DEFAULT_FIT_REQUEST,
      contextTokens: stops.at(-1) ?? 2048,
      parallelSlots: slots,
      kvCacheDtype: 'q8_0',
      gpuLayerFraction: 1,
    };
    const plan = computeFit(facts, request, budgetHw, input.options);
    if (plan.gpuLayers !== undefined && plan.totalLayers) {
      request.gpuLayerFraction = plan.totalLayers > 0 ? plan.gpuLayers / plan.totalLayers : 0;
    }
    compromises.push(
      plan.verdict === 'wont-load'
        ? 'This model does not fit on this machine even at the smallest context.'
        : 'Part of the model will run on the CPU, which is much slower than the GPU.',
    );
    best = { request, plan };
  }

  return {
    request: best.request,
    plan: best.plan,
    headline: headlineFor(best.plan, best.request),
    tradeoff: tradeoffFor(best.plan, hardware, fraction),
    compromises,
  };
}

function unknownResult(request: FitRequest, plan: FitPlan): AutoFitResult {
  return {
    request,
    plan,
    headline: 'We cannot tell what this model needs.',
    tradeoff: "This file does not publish its layer geometry, so any figure here would be invented. Load it and we'll measure what it actually takes.",
    compromises: [],
  };
}

/**
 * The machine, as the budget sees it.
 *
 * Only the free figures are scaled: totals are what the hardware has, and showing
 * a scaled total would misreport the machine. Unified memory stays one pool, so a
 * 50% budget on a 64 GB Mac is 32 GB once, not 32 GB twice.
 */
function scaleHardware(hw: HardwareFacts, fraction: number): HardwareFacts {
  return {
    ...hw,
    devices: hw.devices.map((d) => ({ ...d, freeBytes: Math.floor(d.freeBytes * fraction) })),
    systemRamFreeBytes: Math.floor(hw.systemRamFreeBytes * fraction),
  };
}

function headlineFor(plan: FitPlan, req: FitRequest): string {
  const ctx = formatTokens(req.contextTokens);
  if (plan.verdict === 'wont-load') return `Will not load at ${ctx} of context.`;
  // With no GPU there is no split to describe: everything runs on the CPU, and a
  // "0 of 32 layers on the GPU" phrasing would imply a card that is not there.
  if (!plan.deviceName) return `${ctx} of context, on the CPU.`;
  const where =
    plan.totalLayers && plan.gpuLayers !== undefined && plan.gpuLayers < plan.totalLayers
      ? `${plan.gpuLayers} of ${plan.totalLayers} layers on the GPU`
      : 'entirely on the GPU';
  return `${ctx} of context, ${where}.`;
}

function tradeoffFor(plan: FitPlan, hw: HardwareFacts, fraction: number): string {
  const used = formatBytes(plan.requiredBytes);
  const free = plan.deviceFreeBytes;
  const leftover = Math.max(0, free - plan.requiredBytes);
  const pool = hw.unified ? 'memory' : plan.deviceName ? 'VRAM' : 'RAM';
  if (plan.verdict === 'wont-load') {
    return `It needs about ${used}, which is more than this machine has free.`;
  }
  const outside = Math.max(0, Math.floor(free / Math.max(fraction, 0.01)) - free);
  return `About ${used} of ${pool}, leaving ${formatBytes(leftover + outside)} for everything else.`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : hi;
}

function formatTokens(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(n / 1024 ** 2))} MB`;
}
