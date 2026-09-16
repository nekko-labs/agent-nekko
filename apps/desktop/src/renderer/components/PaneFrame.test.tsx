import { describe, it, expect } from 'vitest';
import { edgeAt } from './PaneFrame.js';

/** A 200×100 window at the origin, the shape most drops land on. */
const rect = { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 } as DOMRect;

describe('edgeAt', () => {
  it('reads the nearest edge, so each corner belongs to its shorter side', () => {
    expect(edgeAt(rect, 5, 50)).toBe('left');
    expect(edgeAt(rect, 195, 50)).toBe('right');
    expect(edgeAt(rect, 100, 5)).toBe('up');
    expect(edgeAt(rect, 100, 95)).toBe('down');
  });

  it('splits a window into four triangles rather than four bands', () => {
    // Nearer the top than the left in *fractions* of the window, even though
    // the top is further away in pixels: a wide window's bands are wide too.
    expect(edgeAt(rect, 30, 10)).toBe('up');
    expect(edgeAt(rect, 10, 30)).toBe('left');
  });

  it('never returns nothing for a point in the middle', () => {
    expect(['up', 'down', 'left', 'right']).toContain(edgeAt(rect, 100, 50));
  });

  it('survives a window that has been measured at zero size', () => {
    const empty = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect;
    expect(['up', 'down', 'left', 'right']).toContain(edgeAt(empty, 0, 0));
  });
});
