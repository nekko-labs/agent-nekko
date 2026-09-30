import { execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';

/** A display adapter the OS reports, whether or not its driver has a stats tool. */
export interface GpuAdapter {
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  name: string;
}

/** PCI vendor ids, as Windows (`VEN_xxxx`) and Linux (`0xxxxx`) both spell them. */
const PCI_VENDORS: Record<string, GpuAdapter['vendor']> = { '10de': 'nvidia', '1002': 'amd', '1022': 'amd', '8086': 'intel' };

/** Adapters that are not a GPU the engine could use. */
const NOT_A_GPU = /basic display|basic render|remote|virtual|hyper-v|parsec|displaylink|\bidd\b|spacedesk/i;

let cached: Promise<GpuAdapter[]> | null = null;

/**
 * The GPUs present, found without any vendor tool.
 *
 * `getGpuStats` needs `nvidia-smi`, so on an AMD or Intel PC it reports no GPU
 * at all, and choosing an engine build from it offered those machines the CPU
 * build. This asks the OS instead (the video controller list on Windows, the
 * DRM devices on Linux), which is enough to know a Vulkan build is worth
 * offering. Read once per process; adapters do not change while it runs.
 */
export function detectGpuAdapters(): Promise<GpuAdapter[]> {
  cached ??= probe().catch(() => []);
  return cached;
}

async function probe(): Promise<GpuAdapter[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + $_.PNPDeviceID }';
    return parseWindowsAdapters(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  if (process.platform === 'linux') {
    const cards = (await readdir('/sys/class/drm').catch(() => [] as string[])).filter((d) => /^card\d+$/.test(d));
    const found: GpuAdapter[] = [];
    for (const card of cards) {
      const id = (await readFile(`/sys/class/drm/${card}/device/vendor`, 'utf8').catch(() => '')).trim();
      const vendor = PCI_VENDORS[id.replace(/^0x/i, '').toLowerCase()];
      if (vendor) found.push({ vendor, name: card });
    }
    return found;
  }
  return [];
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

/** `Name|PNPDeviceID` lines from `Win32_VideoController`. */
export function parseWindowsAdapters(text: string): GpuAdapter[] {
  const out: GpuAdapter[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [name = '', pnp = ''] = line.split('|');
    if (!name.trim() || NOT_A_GPU.test(name)) continue;
    const ven = /VEN_([0-9A-F]{4})/i.exec(pnp)?.[1]?.toLowerCase();
    out.push({ vendor: (ven && PCI_VENDORS[ven]) || 'other', name: name.trim() });
  }
  return out;
}
