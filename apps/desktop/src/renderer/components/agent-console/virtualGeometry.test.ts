import { describe, expect, it } from 'vitest';
import { bottomRange, isPinned, prefixOffsets, rangeFor, rowAt, shiftAbove } from './virtualGeometry.js';

const sizes = [100, 50, 200, 25, 125]; // starts: 0 100 150 350 375, total 500
const offsets = prefixOffsets(sizes.length, (i) => sizes[i]);

describe('virtual transcript geometry', () => {
  it('accumulates row starts and the total', () => {
    expect([...offsets]).toEqual([0, 100, 150, 350, 375, 500]);
    expect([...prefixOffsets(0, () => 10)]).toEqual([0]);
  });

  it('finds the row under a position', () => {
    expect(rowAt(offsets, -10)).toBe(0);
    expect(rowAt(offsets, 0)).toBe(0);
    expect(rowAt(offsets, 99.5)).toBe(0);
    expect(rowAt(offsets, 100)).toBe(1);
    expect(rowAt(offsets, 360)).toBe(3);
    expect(rowAt(offsets, 499)).toBe(4);
    expect(rowAt(offsets, 10_000)).toBe(4);
  });

  it('covers the viewport plus the overscan', () => {
    expect(rangeFor(offsets, 120, 200, 0)).toEqual({ start: 1, end: 3 });
    expect(rangeFor(offsets, 120, 200, 160)).toEqual({ start: 0, end: 4 });
    expect(rangeFor(prefixOffsets(0, () => 0), 0, 100, 50)).toEqual({ start: 0, end: 0 });
  });

  it('renders the newest rows when pinned to the bottom', () => {
    expect(bottomRange(offsets, 140, 0)).toEqual({ start: 3, end: 5 });
    // A viewport taller than the list renders everything.
    expect(bottomRange(offsets, 5_000, 0)).toEqual({ start: 0, end: 5 });
  });

  it('moves the scroll position only for rows that ended above the viewport', () => {
    expect(shiftAbove([{ oldBottom: -40, delta: 30 }, { oldBottom: -5, delta: -10 }], 0)).toBe(20);
    // A row the reader can see, even partly, grows downwards instead.
    expect(shiftAbove([{ oldBottom: 10, delta: 300 }], 0)).toBe(0);
  });

  it('counts the reader as following within the threshold of the bottom', () => {
    expect(isPinned(1000, 900, 100)).toBe(true);
    expect(isPinned(1000, 830, 100)).toBe(true);
    expect(isPinned(1000, 500, 100)).toBe(false);
  });
});
