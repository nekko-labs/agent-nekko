import { kvBytesPerElement, type FitRequest, type ModelFacts } from '@agent-nekko/shared';

/**
 * KV-cache bytes for a model at a given context and parallelism:
 *
 *   2 (one K, one V) x layers x kvHeads x headDim x context x bytesPerElement x slots
 *
 * The `slots` term is the one people get bitten by. Every concurrent slot gets
 * its own full cache, so raising OLLAMA_NUM_PARALLEL from 1 to 4 quadruples the
 * cache at the same context length, and a model that fit yesterday starts
 * spilling onto the CPU today with nothing else having changed.
 *
 * Returns null when the geometry is unknown. That null becomes an `unknown`
 * verdict upstream. It never becomes a guess.
 */
export function kvCacheBytes(facts: ModelFacts, req: FitRequest): number | null {
  const { layers, kvHeads, headDim } = facts;
  if (!layers || !kvHeads || !headDim) return null;
  const slots = Math.max(1, req.parallelSlots);
  const ctx = Math.max(0, req.contextTokens);
  return 2 * layers * kvHeads * headDim * ctx * kvBytesPerElement(req.kvCacheDtype) * slots;
}

/** Below this, no runtime we know of loads anything at all. */
const OVERHEAD_FLOOR_BYTES = 256 * 1024 * 1024;

/** Context past this point stops growing the compute buffers meaningfully. */
const GRAPH_CONTEXT_CAP = 8192;

/**
 * Compute buffers, the graph, and the runtime's own reserve.
 *
 * There is no published formula for this that holds across llama.cpp, LM Studio,
 * and vLLM, so it is deliberately a floor plus a context-proportional term rather
 * than false precision. `floorBytes` is how the calibration store replaces the
 * constant with something actually measured on this machine: see
 * host/runtimes/calibration.ts, which feeds back the residual between what we
 * projected and what the runtime really took.
 */
export function estimateOverheadBytes(
  facts: ModelFacts,
  req: FitRequest,
  floorBytes = OVERHEAD_FLOOR_BYTES,
): number {
  // Per-token graph cost. Compute buffers scale with the batch the runtime works
  // on rather than the whole window, so this is a small per-token term under a
  // cap, not the full context. Measured against llama.cpp and LM Studio an 8B
  // model at 8k lands near 400 MB total, which this reproduces.
  const perTokenGraph = (facts.layers ?? 32) * (facts.headDim ?? 128) * 4;
  const scaled = perTokenGraph * Math.min(Math.max(0, req.contextTokens), GRAPH_CONTEXT_CAP);
  return Math.max(floorBytes, OVERHEAD_FLOOR_BYTES) + scaled;
}

/**
 * Per-head dimension from the two fields runtimes actually publish. Models with
 * grouped-query attention report fewer KV heads than attention heads, but the
 * head dimension is derived from the full head count either way.
 */
export function headDimOf(embeddingLength?: number, headCount?: number): number | undefined {
  if (!embeddingLength || !headCount) return undefined;
  const d = Math.round(embeddingLength / headCount);
  return Number.isFinite(d) && d > 0 ? d : undefined;
}
