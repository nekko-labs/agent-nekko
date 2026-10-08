import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createEngineInstaller } from './install.js';
import { createDownloads } from './download.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('installed binary lookup', () => {
  it('prefers external, then managed, then PATH without reading GPU stats or probing versions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-bin-')); dirs.push(dir);
    const external = join(dir, 'external');
    const managed = join(dir, 'managed');
    const onPath = join(dir, 'on-path');
    for (const path of [external, managed, onPath]) await writeFile(path, 'fixture');
    await writeFile(join(dir, 'engine.json'), JSON.stringify({ binPath: managed }));
    let selected: string | undefined = external;
    const getGpuStats = vi.fn(async () => { throw new Error('must not recurse'); });
    const run = vi.fn(async () => onPath);
    const installer = createEngineInstaller({ engineDir: () => dir, downloads: createDownloads({}), getGpuStats, externalPath: () => selected, run, platform: 'linux' });
    expect(await installer.installedBin()).toBe(external);
    expect(run).not.toHaveBeenCalled();
    selected = join(dir, 'missing');
    expect(await installer.installedBin()).toBe(managed);
    expect(run).not.toHaveBeenCalled();
    await rm(managed);
    expect(await installer.installedBin()).toBe(onPath);
    expect(run).toHaveBeenCalledExactlyOnceWith('which', ['llama-server'], 4000);
    expect(getGpuStats).not.toHaveBeenCalled();
  });

  it('returns undefined for a missing install and failed PATH lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nekko-bin-')); dirs.push(dir);
    const installer = createEngineInstaller({ engineDir: () => dir, downloads: createDownloads({}), getGpuStats: async () => { throw new Error('must not recurse'); }, run: async () => null, platform: 'linux' });
    expect(await installer.installedBin()).toBeUndefined();
  });
});
