import { describe, expect, it } from 'vitest';
import type { MachineFacts } from '@agent-nekko/shared';
import { evaluateReadiness } from './evaluate.js';
import { OFFLINE_STACK_CATALOG } from './catalog.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A machine where every probe answered. The RTX 5090 dev box, essentially. */
const rtx5090: MachineFacts = {
  os: { platform: 'win32', release: '10.0.26200', arch: 'x64' },
  cpuFeatures: ['avx2', 'avx512'],
  backends: ['cuda', 'cpu'],
  devices: [{ name: 'RTX 5090', totalBytes: 32 * GB, freeBytes: 29 * GB }],
  unified: false,
  systemRamTotalBytes: 64 * GB,
  systemRamFreeBytes: 48 * GB,
  diskFreeBytes: 500 * GB,
};

const macM1Max: MachineFacts = {
  os: { platform: 'darwin', release: '25.6.0', arch: 'arm64' },
  cpuFeatures: ['neon'],
  backends: ['metal', 'cpu'],
  devices: [{ name: 'Apple M1 Max', totalBytes: 64 * GB, freeBytes: 40 * GB }],
  unified: true,
  systemRamTotalBytes: 64 * GB,
  systemRamFreeBytes: 40 * GB,
  diskFreeBytes: 300 * GB,
};

const cpuOnlyLaptop: MachineFacts = {
  os: { platform: 'linux', release: '6.8', arch: 'x64' },
  cpuFeatures: ['avx2'],
  backends: ['cpu'],
  devices: [],
  unified: false,
  systemRamTotalBytes: 16 * GB,
  systemRamFreeBytes: 10 * GB,
  diskFreeBytes: 200 * GB,
};

const byRole = (r: ReturnType<typeof evaluateReadiness>, role: string) =>
  r.roles.find((a) => a.role === role)!;
const codes = (a: { reasons: { code: string }[] }) => a.reasons.map((r) => r.code);

describe('evaluateReadiness', () => {
  it('recommends a full GPU stack on a machine that comfortably holds it', () => {
    const r = evaluateReadiness(rtx5090, OFFLINE_STACK_CATALOG);
    expect(r.verdict).toBe('recommended');
    expect(byRole(r, 'runtime').pick?.id).toBe('llama-server-cuda');
    expect(byRole(r, 'intent').pick?.id).toBe('qwen25-14b-q4km');
    expect(byRole(r, 'stt').pick?.id).toBe('whisper-small-en');
    expect(byRole(r, 'tts').pick?.id).toBe('kokoro-82m');
    expect(r.combined.memoryBytes).toBeGreaterThan(0);
    expect(r.unknowns).toEqual([]);
  });

  it('falls back to CPU-resident intent on a GPU-less machine', () => {
    const r = evaluateReadiness(cpuOnlyLaptop, OFFLINE_STACK_CATALOG);
    const intent = byRole(r, 'intent');
    expect(intent.pick?.id).toBe('qwen25-3b-q4km');
    expect(codes(intent)).toContain('cpu-only');
    expect(codes(intent)).toContain('below-recommended');
    expect(byRole(r, 'runtime').pick?.id).toBe('llama-server-cpu');
    expect(r.verdict).toBe('compatible');
  });

  it('reports insufficient when the OS is unsupported everywhere', () => {
    const bsd: MachineFacts = { ...cpuOnlyLaptop, os: { platform: 'freebsd', release: '14', arch: 'x64' } };
    const r = evaluateReadiness(bsd, OFFLINE_STACK_CATALOG);
    expect(r.verdict).toBe('insufficient');
    expect(byRole(r, 'runtime').pick).toBeNull();
    expect(codes(byRole(r, 'runtime'))).toContain('unsupported-os');
    expect(codes(byRole(r, 'runtime'))).toContain('no-candidate');
  });

  it('excludes wrong-arch builds (Intel Mac gets no Metal pick)', () => {
    const intelMac: MachineFacts = { ...macM1Max, os: { platform: 'darwin', release: '25.6.0', arch: 'x64' }, unified: false, devices: [], backends: ['cpu'], systemRamTotalBytes: 16 * GB, systemRamFreeBytes: 10 * GB };
    const r = evaluateReadiness(intelMac, OFFLINE_STACK_CATALOG);
    expect(byRole(r, 'runtime').pick?.id).toBe('llama-server-cpu');
  });

  it('fails honestly on a machine with too little RAM for anything', () => {
    const tiny: MachineFacts = { ...cpuOnlyLaptop, systemRamTotalBytes: 4 * GB, systemRamFreeBytes: 2 * GB };
    const r = evaluateReadiness(tiny, OFFLINE_STACK_CATALOG);
    expect(r.verdict).toBe('insufficient');
    expect(r.roles.every((a) => a.pick === null)).toBe(true);
    expect(codes(byRole(r, 'intent'))).toContain('low-memory');
  });

  it('fails on combined disk footprint even when each part is small', () => {
    const noDisk: MachineFacts = { ...rtx5090, diskFreeBytes: 1 * GB };
    const r = evaluateReadiness(noDisk, OFFLINE_STACK_CATALOG);
    expect(r.verdict).toBe('insufficient');
    expect(codes(r)).toContain('combined-exceeds-disk');
  });

  it('counts unified memory once, never pooled with itself', () => {
    const r = evaluateReadiness(macM1Max, OFFLINE_STACK_CATALOG);
    expect(codes(r)).toContain('unified-memory');
    // Budget is RAM minus the reserve only; the device pool is the same bytes.
    expect(r.combined.budgetBytes).toBe(macM1Max.systemRamFreeBytes - 4 * GB);
    expect(byRole(r, 'runtime').pick?.id).toBe('llama-server-metal');
  });

  it('never pools two discrete GPUs into one big device', () => {
    const twoSmallGpus: MachineFacts = {
      ...rtx5090,
      devices: [
        { name: 'GPU A', totalBytes: 4 * GB, freeBytes: 4 * GB },
        { name: 'GPU B', totalBytes: 4 * GB, freeBytes: 4 * GB },
      ],
    };
    const r = evaluateReadiness(twoSmallGpus, OFFLINE_STACK_CATALOG);
    expect(codes(r)).toContain('devices-not-pooled');
    const intent = byRole(r, 'intent');
    // 8 GB pooled would hold the 7B; two separate 4 GB devices cannot, so it
    // either falls back to RAM or steps down to a model one device can hold.
    const pick = intent.pick!;
    if (pick.memoryBytes > 4 * GB) {
      expect(codes(intent)).toContain('cpu-only');
    } else {
      expect(pick.id).toBe('qwen25-3b-q4km');
    }
  });

  it('answers unverified (not a guess) when probes did not run', () => {
    const unprobed: MachineFacts = { ...rtx5090, cpuFeatures: null, diskFreeBytes: null };
    const r = evaluateReadiness(unprobed, OFFLINE_STACK_CATALOG);
    expect(r.unknowns).toContain('cpu features');
    expect(r.unknowns).toContain('free disk');
    // The CUDA runtime needs avx2; without the probe its role caps at unverified.
    expect(byRole(r, 'runtime').verdict).toBe('unverified');
    expect(codes(byRole(r, 'runtime'))).toContain('cpu-feature-unprobed');
    expect(r.verdict).toBe('unverified');
  });

  it('rejects the stack when parts fit alone but not together', () => {
    // 6.5 GB free, no GPU: after the 4 GB OS/app reserve the budget is 2.5 GB,
    // and even the smallest complete stack (1.5B intent + whisper base + piper
    // + cpu runtime at ~3.0 GB) cannot be concurrently resident.
    const tight: MachineFacts = { ...cpuOnlyLaptop, systemRamFreeBytes: 6.5 * GB };
    const r = evaluateReadiness(tight, OFFLINE_STACK_CATALOG);
    expect(r.verdict).toBe('insufficient');
    const unfilled = r.roles.filter((a) => a.pick === null);
    expect(unfilled.length).toBeGreaterThan(0);
    expect(codes(unfilled[0])).toContain('low-memory');
  });

  it('filters speech components by the requested language', () => {
    const r = evaluateReadiness(rtx5090, OFFLINE_STACK_CATALOG, { language: 'ja' });
    expect(byRole(r, 'stt').pick?.id).toBe('whisper-small-multi');
    expect(byRole(r, 'tts').pick?.id).toBe('kokoro-82m');
  });

  it('flags picks whose artifacts carry no pinned hash', () => {
    const r = evaluateReadiness(rtx5090, OFFLINE_STACK_CATALOG);
    // Nothing in the catalog is hash-pinned yet (AN9c pins them); the report
    // must say so rather than imply verified downloads.
    expect(byRole(r, 'intent').reasons.some((x) => x.code === 'artifact-unpinned')).toBe(true);
  });

  it('offers alternates so the UI can show other eligible picks', () => {
    const r = evaluateReadiness(rtx5090, OFFLINE_STACK_CATALOG);
    expect(byRole(r, 'intent').alternates.length).toBeGreaterThan(0);
    expect(byRole(r, 'intent').alternates.map((a) => a.id)).toContain('llama31-8b-q4km');
  });
});
