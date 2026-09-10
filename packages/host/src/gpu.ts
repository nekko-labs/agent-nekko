import { execFile } from 'child_process';
import os from 'os';
import type { GpuStats } from '@agent-nekko/shared';
import { parseIoregAccelerators, toGpuDevices } from './gpu-macos.js';

/**
 * GPU/VRAM stats for the Chat metrics bar and Command Center.
 *
 * Two probes, chosen by platform, both of which run without elevated rights:
 *  - `nvidia-smi` on Windows and Linux (the one query that works identically on
 *    both), reporting a discrete card's own VRAM.
 *  - `ioreg` on macOS, reading the accelerator driver's published counters. The
 *    GPU there shares one memory pool with the CPU, so the reading is flagged
 *    `unified` and measured against system RAM (see gpu-macos.ts).
 *
 * We return null when neither probe finds a GPU (no NVIDIA driver on a PC, or a
 * Mac whose driver publishes no statistics). Results are cached briefly so a
 * polling UI doesn't spawn a process on every tick.
 */

let cache: { at: number; stats: GpuStats | null } | null = null;
const TTL_MS = 2500;
let inFlight: Promise<GpuStats | null> | null = null;

export async function getGpuStats(): Promise<GpuStats | null> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.stats;
  if (inFlight) return inFlight;
  inFlight = probe()
    .then((stats) => {
      cache = { at: Date.now(), stats };
      return stats;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Ask the platform's probe. macOS never has `nvidia-smi` (Apple dropped NVIDIA
 * support long before Apple Silicon), so it goes straight to the registry rather
 * than paying for a spawn that always fails.
 */
function probe(): Promise<GpuStats | null> {
  return process.platform === 'darwin' ? queryIoreg() : queryNvidiaSmi();
}

/** Run a command, resolving its stdout or null on any failure/timeout. */
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/** Sum a device list into the aggregate the monitor surfaces read. */
function aggregate(source: GpuStats['source'], devices: GpuStats['devices'], unified: boolean): GpuStats | null {
  if (devices.length === 0) return null;
  return {
    source,
    devices,
    unified: unified || undefined,
    // Unified memory is one pool every accelerator draws from, so summing the
    // per-device totals would count the same RAM once per GPU.
    totalMB: unified ? devices[0].memoryTotalMB : devices.reduce((s, d) => s + d.memoryTotalMB, 0),
    usedMB: devices.reduce((s, d) => s + d.memoryUsedMB, 0),
    freeMB: unified
      ? Math.max(0, devices[0].memoryTotalMB - devices.reduce((s, d) => s + d.memoryUsedMB, 0))
      : devices.reduce((s, d) => s + d.memoryFreeMB, 0),
  };
}

async function queryNvidiaSmi(): Promise<GpuStats | null> {
  const stdout = await run('nvidia-smi', [
    '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu',
    '--format=csv,noheader,nounits',
  ]);
  if (!stdout) return null;

  const devices = stdout
    .trim()
    .split('\n')
    .map((line) => line.split(',').map((s) => s.trim()))
    .filter((cols) => cols.length >= 4)
    .map((cols) => {
      const [name, total, used, free, util] = cols;
      return {
        name: name || 'GPU',
        memoryTotalMB: Number(total) || 0,
        memoryUsedMB: Number(used) || 0,
        memoryFreeMB: Number(free) || 0,
        utilizationPct: util !== undefined && util !== '' && util !== '[N/A]' ? Number(util) : undefined,
      };
    })
    .filter((d) => d.memoryTotalMB > 0);

  return aggregate('nvidia-smi', devices, false);
}

/**
 * macOS: read the accelerator driver's counters out of the IO registry. `-r -d 1`
 * limits the dump to the matched nodes and their own properties (no children),
 * and `-w 0` stops ioreg wrapping a dictionary across lines mid-value.
 */
async function queryIoreg(): Promise<GpuStats | null> {
  const stdout = await run('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
  if (!stdout) return null;
  const unifiedTotalMB = Math.round(os.totalmem() / 1024 / 1024);
  if (unifiedTotalMB <= 0) return null;
  return aggregate('ioreg', toGpuDevices(parseIoregAccelerators(stdout), unifiedTotalMB), true);
}
