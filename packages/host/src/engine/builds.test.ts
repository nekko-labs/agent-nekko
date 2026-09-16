import { describe, expect, it } from 'vitest';
import type { GpuStats } from '@agent-nekko/shared';
import { buildsFor, matchAsset, matchCompanion, recommendedBuild } from './builds.js';

/**
 * Picking the wrong build is the most expensive mistake this feature can make:
 * several hundred megabytes downloaded, then a server that will not start. The
 * rule under test is that acceleration is only chosen where there is evidence
 * for it, and CPU is the fallback rather than an afterthought.
 */

const nvidia: GpuStats = {
  source: 'nvidia-smi',
  devices: [{ name: 'RTX 5090', memoryTotalMB: 32607, memoryUsedMB: 1000, memoryFreeMB: 31607 }],
  totalMB: 32607,
  usedMB: 1000,
  freeMB: 31607,
};

const apple: GpuStats = {
  source: 'ioreg',
  devices: [{ name: 'Apple M1 Max', memoryTotalMB: 65536, memoryUsedMB: 20000, memoryFreeMB: 45536 }],
  totalMB: 65536,
  usedMB: 20000,
  freeMB: 45536,
  unified: true,
};

const noGpu: GpuStats = { source: 'none', devices: [], totalMB: 0, usedMB: 0, freeMB: 0 };

describe('build selection', () => {
  it('picks CUDA on Windows with an NVIDIA reading', () => {
    expect(recommendedBuild('win32', 'x64', nvidia)?.backend).toBe('cuda');
  });

  it('does not pick CUDA on Windows without one', () => {
    expect(recommendedBuild('win32', 'x64', noGpu)?.backend).toBe('cpu');
  });

  it('picks Vulkan for a GPU it cannot identify as NVIDIA', () => {
    // An `ioreg`-sourced or otherwise unlabelled device is evidence of a GPU, not
    // evidence of CUDA, and guessing CUDA here downloads a build that cannot run.
    const unknownGpu: GpuStats = { ...apple, source: 'none', unified: false };
    expect(recommendedBuild('win32', 'x64', unknownGpu)?.backend).toBe('vulkan');
  });

  it('picks Metal on Apple Silicon', () => {
    expect(recommendedBuild('darwin', 'arm64', apple)?.backend).toBe('metal');
  });

  it('offers nothing for a platform llama.cpp does not publish for', () => {
    expect(buildsFor('linux', 'mips', nvidia)).toEqual([]);
    expect(recommendedBuild('linux', 'mips', nvidia)).toBeUndefined();
  });

  it('still lists the other builds so the choice can be overridden', () => {
    const backends = buildsFor('win32', 'x64', nvidia).map((b) => b.backend);
    expect(backends).toContain('vulkan');
    expect(backends).toContain('cpu');
    expect(backends[0]).toBe('cuda');
  });
});

describe('asset matching', () => {
  // Names as llama.cpp actually publishes them, build tag and all.
  const assets = [
    'llama-b7021-bin-win-cpu-x64.zip',
    'llama-b7021-bin-win-cuda-12.4-x64.zip',
    'llama-b7021-bin-win-cuda-13.0-x64.zip',
    'llama-b7021-bin-win-vulkan-x64.zip',
    'llama-b7021-bin-macos-arm64.zip',
    'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'llama-b7021.tar.gz',
    'llama-b7021-bin-win-cuda-12.4-x64.zip.sha256',
  ];

  it('matches the build regardless of the release tag', () => {
    const cuda = buildsFor('win32', 'x64', nvidia)[0];
    expect(matchAsset(cuda, assets)).toBe('llama-b7021-bin-win-cuda-13.0-x64.zip');
  });

  it('prefers the newest toolkit when several are published', () => {
    const cuda = buildsFor('win32', 'x64', nvidia)[0];
    expect(matchAsset(cuda, assets)).toContain('13.0');
  });

  it('ignores checksum files that carry the same name', () => {
    const cuda = buildsFor('win32', 'x64', nvidia)[0];
    expect(matchAsset(cuda, assets)).not.toMatch(/sha256$/);
  });

  it('finds the CUDA runtime companion, and only for CUDA', () => {
    const [cuda, vulkan] = buildsFor('win32', 'x64', nvidia);
    expect(matchCompanion(cuda, assets)).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip');
    expect(matchCompanion(vulkan, assets)).toBeUndefined();
  });

  it('returns nothing when the release has no build for us', () => {
    const metal = buildsFor('darwin', 'arm64', apple)[0];
    expect(matchAsset(metal, ['llama-b7021-bin-win-cpu-x64.zip'])).toBeUndefined();
  });
});
