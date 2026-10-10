import type { GpuDevice } from '@agent-nekko/shared';

/**
 * macOS GPU statistics, parsed out of `ioreg`.
 *
 * There is no `nvidia-smi` on a Mac, and the tool that reports real GPU power and
 * residency, `powermetrics`, needs root, and no monitoring chip is worth a sudo
 * prompt. The accelerator driver publishes its own counters in the IO registry
 * instead, and any user can read them:
 *
 *   ioreg -r -d 1 -w 0 -c IOAccelerator
 *
 * Each accelerator entry carries a `PerformanceStatistics` dictionary holding
 * `Device Utilization %` (the same 0-100 figure `nvidia-smi` reports) and the
 * driver's current allocation in bytes. Apple Silicon has no discrete VRAM, so
 * the allocation is a slice of the unified pool; the caller pairs it with system
 * RAM as the total and flags the reading as unified.
 *
 * The registry's text form is stable and one key/value per line, so it is parsed
 * directly rather than by pulling in a plist reader for the `-a` XML variant.
 * Parsing lives here, apart from the process spawn, so it can be tested against a
 * captured dump.
 */

/** Fields we read out of one accelerator's registry entry. */
export interface MacGpuEntry {
  name: string;
  /** Bytes the accelerator driver currently has allocated from system memory. */
  allocatedBytes: number;
  utilizationPct?: number;
  /** GPU core count, when the entry publishes one (Apple Silicon does). */
  cores?: number;
}

/** `"Device Utilization %"=26` → 26. Absent or unparseable → undefined. */
function num(blob: string, key: string): number | undefined {
  // The key is matched with its closing quote so `"In use system memory"` never
  // matches the neighbouring `"In use system memory (driver)"`.
  const m = new RegExp(`"${key.replace(/[%\\\\^$*+?.()|[\]{}]/g, '\\$&')}"\\s*=\\s*(\\d+)`).exec(blob);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Pull every accelerator out of an `ioreg -c IOAccelerator` dump.
 *
 * Entries begin at a `+-o <ClassName>` header, so the dump splits cleanly on
 * those even when a machine has more than one GPU (an Intel Mac with both an
 * integrated and a discrete card lists both).
 */
export function parseIoregAccelerators(stdout: string): MacGpuEntry[] {
  const out: MacGpuEntry[] = [];
  for (const chunk of stdout.split(/^\+-o /m).slice(1)) {
    const stats = /"PerformanceStatistics"\s*=\s*\{([^}]*)\}/.exec(chunk)?.[1];
    if (!stats) continue;

    // Current driver allocation. Newer drivers report it split between the
    // "system memory" the GPU holds and a driver-private figure; either alone is
    // a valid reading, so take whichever is present.
    const allocatedBytes =
      num(stats, 'Alloc system memory') ??
      num(stats, 'In use system memory') ??
      num(stats, 'In use system memory (driver)');
    if (allocatedBytes === undefined) continue;

    // Prefer the marketing name the driver publishes ("Apple M1 Max"); fall back
    // to the IOKit class in the entry header ("AGXAcceleratorG13X").
    const name =
      /"model"\s*=\s*"([^"]+)"/.exec(chunk)?.[1]?.trim() ||
      /^(\S+)/.exec(chunk)?.[1] ||
      'GPU';

    out.push({
      name,
      allocatedBytes,
      utilizationPct: num(stats, 'Device Utilization %'),
      cores: num(chunk, 'gpu-core-count'),
    });
  }
  return out;
}

const BYTES_PER_MB = 1024 * 1024;

/**
 * Turn parsed registry entries into the devices the monitor renders. `totalMB` is
 * the unified pool (system RAM), shared by every accelerator on the machine, so
 * each device is measured against the same total rather than a pool of its own.
 */
export function toGpuDevices(entries: MacGpuEntry[], unifiedTotalMB: number): GpuDevice[] {
  return entries.map((e) => {
    // Clamp: the allocation is a live counter read a moment apart from the memory
    // total, and a device may never report more than the pool it draws from.
    const usedMB = Math.min(unifiedTotalMB, Math.round(e.allocatedBytes / BYTES_PER_MB));
    return {
      name: e.cores ? `${e.name} (${e.cores}-core GPU)` : e.name,
      memoryTotalMB: unifiedTotalMB,
      memoryUsedMB: usedMB,
      memoryFreeMB: Math.max(0, unifiedTotalMB - usedMB),
      utilizationPct: e.utilizationPct,
    };
  });
}
