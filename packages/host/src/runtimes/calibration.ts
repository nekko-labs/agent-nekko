import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { RuntimeKind } from '@agent-nekko/shared';
import { dataDir } from '../paths.js';

/**
 * Learning the overhead constant instead of guessing it forever.
 *
 * The planner's overhead term (compute buffers plus the runtime's own reserve)
 * has no published formula that holds across three engines, so it starts as a
 * floor. After each load we know what the runtime actually took, and the residual
 * between that and the projection is the correction.
 *
 * The point is not precision for its own sake. A projection nobody can check is a
 * projection nobody should trust, and a hardcoded constant is a guess that never
 * improves. This closes that loop.
 */

const FILE = 'runtime-calibration.json';
/** Weight on each new sample. Low enough that one odd load cannot swing it. */
const EMA_ALPHA = 0.3;
const DEFAULT_FLOOR_BYTES = 256 * 1024 * 1024;
/** Residuals outside this range are measurement noise, not overhead. */
const MIN_FLOOR_BYTES = 64 * 1024 * 1024;
const MAX_FLOOR_BYTES = 8 * 1024 ** 3;

interface Record_ {
  overheadFloorBytes: number;
  samples: number;
}

type Store = Record<string, Record_>;

function file(): string {
  return join(dataDir(), FILE);
}

function read(): Store {
  try {
    const path = file();
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Store;
  } catch {
    // A corrupt file is not worth failing a load over; start fresh.
    return {};
  }
}

function write(store: Store): void {
  try {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2));
  } catch {
    /* calibration is an optimization, never a hard dependency */
  }
}

/** Keyed by version too: a runtime upgrade can change its memory behaviour. */
function keyOf(kind: RuntimeKind, version?: string): string {
  return `${kind}:${version ?? 'unknown'}`;
}

/** The overhead floor to plan with, measured on this machine where we have data. */
export function overheadFloorFor(kind: RuntimeKind, version?: string): number {
  return read()[keyOf(kind, version)]?.overheadFloorBytes ?? DEFAULT_FLOOR_BYTES;
}

/**
 * Fold one measurement back in. `measuredBytes` is what the runtime really took,
 * `projectedBytes` what we said it would, and `projectedOverheadBytes` the part
 * of that projection this store is responsible for.
 */
export function recordMeasurement(
  kind: RuntimeKind,
  version: string | undefined,
  measuredBytes: number,
  projectedBytes: number,
  projectedOverheadBytes: number,
): void {
  if (!Number.isFinite(measuredBytes) || measuredBytes <= 0) return;
  const residual = measuredBytes - projectedBytes;
  const implied = projectedOverheadBytes + residual;
  if (!Number.isFinite(implied) || implied < MIN_FLOOR_BYTES || implied > MAX_FLOOR_BYTES) return;

  const store = read();
  const key = keyOf(kind, version);
  const prev = store[key];
  // Blend from the very first sample rather than adopting it outright: one odd
  // load (a background process grabbing VRAM mid-measurement) should nudge the
  // floor, not define it.
  const base = prev?.overheadFloorBytes ?? DEFAULT_FLOOR_BYTES;
  store[key] = {
    overheadFloorBytes: Math.round(base * (1 - EMA_ALPHA) + implied * EMA_ALPHA),
    samples: (prev?.samples ?? 0) + 1,
  };
  write(store);
}

/** Test seam and a way out if a bad sample ever poisons the store. */
export function resetCalibration(): void {
  write({});
}

export const CALIBRATION_DEFAULTS = {
  DEFAULT_FLOOR_BYTES,
  MIN_FLOOR_BYTES,
  MAX_FLOOR_BYTES,
  EMA_ALPHA,
};
