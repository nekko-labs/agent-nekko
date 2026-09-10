import os from 'os';
import type { SystemStats } from '@agent-nekko/shared';

/**
 * CPU load + RAM use for the monitor surfaces, from `os` alone (no native module,
 * works the same on Windows, macOS, and Linux).
 *
 * CPU percentage is a delta: we keep the previous `os.cpus()` times snapshot and
 * report busy-time over the interval since it, which is what a task manager
 * shows. The first call (and any call after a long gap, e.g. the user switched
 * the CPU monitor back on) measures over a short window instead of reporting a
 * since-boot average.
 */

interface Snapshot {
  at: number;
  idle: number;
  total: number;
}

let prev: Snapshot | null = null;
/** Past this gap the stored snapshot is too old to be a useful interval. */
const STALE_MS = 30_000;
const PRIME_MS = 180;

function snapshot(): Snapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const [kind, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (kind === 'idle') idle += ms;
    }
  }
  return { at: Date.now(), idle, total };
}

function busyPct(from: Snapshot, to: Snapshot): number {
  const dTotal = to.total - from.total;
  const dIdle = to.idle - from.idle;
  if (dTotal <= 0) return 0;
  return Math.min(100, Math.max(0, ((dTotal - dIdle) / dTotal) * 100));
}

export async function getSystemStats(): Promise<SystemStats | null> {
  try {
    let from = prev;
    if (!from || Date.now() - from.at > STALE_MS) {
      from = snapshot();
      await new Promise((r) => setTimeout(r, PRIME_MS));
    }
    const now = snapshot();
    prev = now;

    const cpus = os.cpus();
    const totalMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMB = Math.round(os.freemem() / 1024 / 1024);
    return {
      cpuPct: Math.round(busyPct(from, now)),
      cpuCores: cpus.length,
      cpuModel: cpus[0]?.model?.trim() || undefined,
      memUsedMB: Math.max(0, totalMB - freeMB),
      memTotalMB: totalMB,
    };
  } catch {
    return null;
  }
}
