import { describe, expect, it } from 'vitest';
import { macMemoryUsedMB } from '../system.js';

describe('macOS memory accounting', () => {
  const counters = (pageSize: number) => `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Anonymous pages: 2000000.
Pages purgeable: 50000.
Pages wired down: 200000.
Pages occupied by compressor: 40000.
File-backed pages: 1500000.
Pages inactive: 1800000.
Pages stored in compressor: 100000.`;
  it.each([4096, 16384])('uses physical resident memory on %i-byte pages, excluding caches', size => {
    expect(macMemoryUsedMB(counters(size))).toBe(Math.round(2190000 * size / 1024 / 1024));
  });
  it('does not guess when counters are unavailable', () => {
    expect(macMemoryUsedMB('unavailable')).toBeNull();
    expect(macMemoryUsedMB(counters(0))).toBeNull();
    expect(macMemoryUsedMB(counters(16384).replace('Pages purgeable:', 'Missing:'))).toBeNull();
  });
});
