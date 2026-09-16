import { describe, it, expect } from 'vitest';
import { targetAt } from './PaneFrame.js';

/** A 200×100 window at the origin, the shape most drops land on. */
const rect = { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 } as DOMRect;

describe('targetAt', () => {
  it('reads the nearest edge, so each corner belongs to its shorter side', () => {
    expect(targetAt(rect, 5, 50)).toBe('left');
    expect(targetAt(rect, 195, 50)).toBe('right');
    expect(targetAt(rect, 100, 5)).toBe('up');
    expect(targetAt(rect, 100, 95)).toBe('down');
  });

  it('splits the edges into four triangles rather than four bands', () => {
    // Nearer the top than the left in *fractions* of the window, even though
    // the top is further away in pixels: a wide window's bands are wide too.
    expect(targetAt(rect, 30, 10)).toBe('up');
    expect(targetAt(rect, 10, 30)).toBe('left');
  });

  it('offers a swap in the middle, which no edge could express', () => {
    // Dropping a window on the left edge of the neighbour already to its right
    // reproduces the order it was in, so "put these two the other way round"
    // needs a target of its own rather than an edge.
    expect(targetAt(rect, 100, 50)).toBe('swap');
  });

  it('keeps the edges reachable from anywhere near them', () => {
    // The swap zone is generous, but every edge stays a short move away: a
    // pointer a tenth of the way in still means the edge it is nearest.
    expect(targetAt(rect, 20, 50)).toBe('left');
    expect(targetAt(rect, 180, 50)).toBe('right');
    expect(targetAt(rect, 100, 10)).toBe('up');
    expect(targetAt(rect, 100, 90)).toBe('down');
  });

  it('survives a window that has been measured at zero size', () => {
    const empty = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect;
    expect(['up', 'down', 'left', 'right', 'swap']).toContain(targetAt(empty, 0, 0));
  });
});
