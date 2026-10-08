import { afterEach, describe, expect, it } from 'vitest';
import { getGpuStatsFresh, setEngineBinResolver, setEngineRunner } from './gpu.js';
import { listedToStats, parseListDevices, queryLlamaDevices } from './gpu-vulkan.js';

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
  });

  it('does nothing when no engine has been registered', async () => {
    // No nvidia-smi on a CI box, and no engine: still just "no GPU".
    const stats = await getGpuStatsFresh();
    expect(stats?.source).not.toBe('llama-server');
  });

  it('uses the engine only when nvidia-smi gave no answer, and re-reads on a fresh request', async () => {
    if (process.platform === 'darwin') return; // macOS reads ioreg and never reaches the fallback
    let reads = 0;
    setEngineBinResolver(async () => 'llama-server');
    setEngineRunner(async () => {
      reads += 1;
      return SURFACE;
    });
    const first = await getGpuStatsFresh();
    // A machine that does have a working nvidia-smi answers from it instead.
    if (first?.source === 'nvidia-smi') return;
    expect(first?.source).toBe('llama-server');
    await getGpuStatsFresh();
    expect(reads).toBe(2);
  });
});
