import { execFile } from 'child_process';
import type { GpuDevice, GpuStats } from '@agent-nekko/shared';

/**
 * A GPU reading taken from the engine itself, for machines where the vendor
 * tool does not answer.
 *
 * `nvidia-smi` is missing from PATH on many Windows installs, refuses to run on
 * some hybrid laptops (a Surface Book's GTX 1050 answers "not administrator /
 * no TCC device" on a 2021 driver), and does not exist for AMD or Intel at all.
 * `llama-server --list-devices` asks the same Vulkan/CUDA/ROCm layer the model
 * will actually load through, so a GPU it lists is a GPU the engine can use.
 */

/** One line of `--list-devices`: `  Vulkan0: GeForce GTX 1050 (2225 MiB, 1924 MiB free)`. */
const DEVICE_LINE = /^\s*([A-Za-z]+\d+):\s+(.+?)\s+\((\d+)\s*MiB,\s*(\d+)\s*MiB free\)\s*$/;

/**
 * Integrated parts take their memory from system RAM, so they are not VRAM and
 * must not be added to a discrete card's total. Names are all the engine gives.
 */
const INTEGRATED = /intel.*(uhd|hd graphics|iris)|radeon\(tm\) graphics|radeon graphics|vega\s*\d+\b|apple|adreno|mali/i;

export interface ListedDevice {
  /** The backend's own id, e.g. `Vulkan0`. */
  id: string;
  name: string;
  totalMB: number;
  freeMB: number;
  integrated: boolean;
}

/** Parse `llama-server --list-devices` output. Unknown lines are ignored, never fatal. */
export function parseListDevices(text: string): ListedDevice[] {
  const out: ListedDevice[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = DEVICE_LINE.exec(line);
    if (!m) continue;
    const totalMB = Number(m[3]);
    const freeMB = Number(m[4]);
    if (!Number.isFinite(totalMB) || totalMB <= 0) continue;
    const name = m[2]!.trim();
    out.push({ id: m[1]!, name, totalMB, freeMB: Math.min(Number.isFinite(freeMB) ? freeMB : 0, totalMB), integrated: INTEGRATED.test(name) });
  }
  return out;
}

/**
 * Fold the listed devices into the shape the monitors and fit planner read.
 *
 * Only discrete GPUs count. An integrated part's "memory" is system RAM, so
 * adding it to a card's VRAM would double-count, and offloading to it is not
 * known to beat the CPU. A machine with nothing else keeps reading as having no
 * GPU, exactly as it did before this fallback existed.
 */
export function listedToStats(listed: ListedDevice[]): GpuStats | null {
  const discrete = listed.filter((d) => !d.integrated);
  if (discrete.length === 0) return null;
  const devices: GpuDevice[] = discrete.map((d) => ({
    name: d.name,
    memoryTotalMB: d.totalMB,
    memoryUsedMB: Math.max(0, d.totalMB - d.freeMB),
    memoryFreeMB: d.freeMB,
  }));
  return {
    source: 'llama-server',
    devices,
    totalMB: devices.reduce((s, d) => s + d.memoryTotalMB, 0),
    usedMB: devices.reduce((s, d) => s + d.memoryUsedMB, 0),
    freeMB: devices.reduce((s, d) => s + d.memoryFreeMB, 0),
  };
}

export type RunText = (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>;

/** stdout and stderr together: llama.cpp prints the list on one and its loader chatter on the other. */
export const runCombined: RunText = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}\n${stderr ?? ''}`;
      // A non-zero exit that still printed a device list is an answer.
      resolve(err && parseListDevices(text).length === 0 ? null : text);
    });
  });

/** Ask a `llama-server` which devices it can use. Null when it will not say. */
export async function queryLlamaDevices(bin: string | undefined, run: RunText = runCombined): Promise<GpuStats | null> {
  if (!bin) return null;
  const text = await run(bin, ['--list-devices'], 15_000).catch(() => null);
  return text ? listedToStats(parseListDevices(text)) : null;
}
