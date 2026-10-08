import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGpuStats, getGpuStatsFresh, setEngineBinResolver, setEngineRunner } from './gpu.js';
import { listedToStats, parseListDevices, queryLlamaDevices } from './gpu-vulkan.js';

const vendor = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, _options, callback) => callback(vendor.text ? null : new Error('unavailable'), vendor.text ?? '', '')),
}));

// What `llama-server --list-devices` printed on a Surface Book 2.
const SURFACE = `Available devices:
  Vulkan0: GeForce GTX 1050 (2225 MiB, 1924 MiB free)
  Vulkan1: Intel(R) UHD Graphics 620 (4054 MiB, 3649 MiB free)
`;

describe('llama-server --list-devices', () => {
  it('parses every device line and ignores the rest', () => {
    const noisy = `ggml_vulkan: Found 2 Vulkan devices:\n${SURFACE}load_backend: loaded CPU backend`;
    expect(parseListDevices(noisy).map((d) => [d.id, d.name, d.totalMB, d.freeMB, d.integrated])).toEqual([
      ['Vulkan0', 'GeForce GTX 1050', 2225, 1924, false],
      ['Vulkan1', 'Intel(R) UHD Graphics 620', 4054, 3649, true],
    ]);
  });

  it('returns nothing for text it does not recognise', () => {
    expect(parseListDevices('')).toEqual([]);
    expect(parseListDevices('error: unknown argument')).toEqual([]);
  });

  it('reports the discrete card only, never the integrated part beside it', () => {
    const stats = listedToStats(parseListDevices(SURFACE));
    expect(stats?.source).toBe('llama-server');
    expect(stats?.devices).toHaveLength(1);
    expect(stats).toMatchObject({ totalMB: 2225, freeMB: 1924, usedMB: 301 });
    expect(stats?.unified).toBeUndefined();
  });

  it('keeps an integrated-only machine reading as having no GPU', () => {
    expect(listedToStats(parseListDevices('  Vulkan0: Intel(R) UHD Graphics 620 (4054 MiB, 3649 MiB free)'))).toBeNull();
    expect(listedToStats(parseListDevices('  Vulkan0: AMD Radeon(TM) Graphics (2048 MiB, 2000 MiB free)'))).toBeNull();
  });

  it('does not mistake discrete Radeon RX Vega cards for integrated Vega graphics', () => {
    const stats = listedToStats(parseListDevices(
      'Vulkan0: Radeon RX Vega 56 (8192 MiB, 8000 MiB free)\nVulkan1: Radeon RX Vega 64 (8192 MiB, 8000 MiB free)\nVulkan2: AMD Radeon(TM) Vega 8 Graphics (2048 MiB, 2000 MiB free)',
    ));
    expect(stats?.devices.map(d => d.name)).toEqual(['Radeon RX Vega 56', 'Radeon RX Vega 64']);
    expect(stats?.totalMB).toBe(16384);
  });

  it('sums several discrete cards', () => {
    const stats = listedToStats(
      parseListDevices('  Vulkan0: AMD Radeon RX 6700 XT (12272 MiB, 12000 MiB free)\n  Vulkan1: AMD Radeon RX 580 (8192 MiB, 8000 MiB free)'),
    );
    expect(stats).toMatchObject({ totalMB: 20464, freeMB: 20000 });
  });

  it('caps free memory at the total when a driver reports more', () => {
    expect(listedToStats(parseListDevices('  Vulkan0: GeForce GTX 1050 (2000 MiB, 9999 MiB free)'))).toMatchObject({ freeMB: 2000, usedMB: 0 });
  });

  it('queries the binary it is given, and says nothing without one', async () => {
    const calls: string[][] = [];
    const run = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return SURFACE;
    };
    expect(await queryLlamaDevices(undefined, run)).toBeNull();
    expect((await queryLlamaDevices('llama-server', run))?.devices[0]?.name).toBe('GeForce GTX 1050');
    expect(calls).toEqual([['--list-devices']]);
  });

  it('is null when the process fails or prints nothing usable', async () => {
    expect(await queryLlamaDevices('llama-server', async () => null)).toBeNull();
    expect(await queryLlamaDevices('llama-server', async () => 'usage: llama-server')).toBeNull();
    expect(await queryLlamaDevices('llama-server', async () => { throw new Error('spawn failed'); })).toBeNull();
  });
});

describe('GPU probe fallback', () => {
  afterEach(() => {
    setEngineBinResolver(undefined);
    setEngineRunner(undefined);
    vendor.text = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function linux() {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
  }

  it('does nothing when no engine has been registered', async () => {
    linux();
    expect(await getGpuStatsFresh()).toBeNull();
  });

  it('uses the engine when nvidia-smi fails, and re-reads on a fresh request', async () => {
    linux();
    const run = vi.fn(async () => SURFACE);
    setEngineBinResolver(async () => 'llama-server');
    setEngineRunner(run);
    expect((await getGpuStatsFresh())?.source).toBe('llama-server');
    await getGpuStatsFresh();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('prefers the vendor reading without querying the engine', async () => {
    linux();
    vendor.text = 'GTX 1050, 2225, 301, 1924, 12';
    const run = vi.fn(async () => SURFACE);
    setEngineBinResolver(async () => 'llama-server');
    setEngineRunner(run);
    expect((await getGpuStatsFresh())?.source).toBe('nvidia-smi');
    expect(run).not.toHaveBeenCalled();
  });

  it('caches the fallback for 15 seconds and invalidates the monitor cache on registration', async () => {
    linux();
    vi.useFakeTimers();
    expect(await getGpuStats()).toBeNull();
    const run = vi.fn(async () => SURFACE);
    setEngineBinResolver(async () => 'llama-server');
    setEngineRunner(run);
    expect((await getGpuStats())?.source).toBe('llama-server');
    vi.advanceTimersByTime(3000);
    await getGpuStats();
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(12000);
    await getGpuStats();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('returns null when the binary resolver fails', async () => {
    linux();
    setEngineBinResolver(async () => { throw new Error('missing install'); });
    const run = vi.fn(async () => SURFACE);
    setEngineRunner(run);
    expect(await getGpuStatsFresh()).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('never queries the engine on macOS', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    const run = vi.fn(async () => SURFACE);
    setEngineBinResolver(async () => 'llama-server');
    setEngineRunner(run);
    await getGpuStatsFresh();
    expect(run).not.toHaveBeenCalled();
  });
});
