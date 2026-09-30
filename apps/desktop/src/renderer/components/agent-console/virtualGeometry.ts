/**
 * The arithmetic behind VirtualTranscript, kept pure so it can be tested
 * without a DOM: where each row starts, which rows a viewport needs, and how
 * far to move the scroll position when a row above the reader changes size.
 */

/**
 * Start offset of every row, plus the total height at the end: `offsets[i]` is
 * where row `i` starts and `offsets[count]` is the list's full height.
 */
export function prefixOffsets(count: number, sizeOf: (i: number) => number): Float64Array {
  const out = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) out[i + 1] = out[i] + Math.max(0, sizeOf(i));
  return out;
}

/** The row containing list-relative position `y` (clamped to the list). */
export function rowAt(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  if (y <= 0) return 0;
  if (y >= offsets[count]) return count - 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface RowRange {
  /** First rendered row. */
  start: number;
  /** One past the last rendered row. */
  end: number;
}

/**
 * The rows to render for a viewport spanning [top, bottom) in list
 * coordinates, widened by `overscan` pixels on each side so a fast scroll does
 * not show blank space before the next render lands.
 */
export function rangeFor(offsets: Float64Array, top: number, bottom: number, overscan: number): RowRange {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const start = rowAt(offsets, top - overscan);
  const last = rowAt(offsets, Math.max(top, bottom + overscan - 1));
  return { start, end: Math.min(count, last + 1) };
}

/** The rows for a viewport of `height` pinned to the bottom of the list. */
export function bottomRange(offsets: Float64Array, height: number, overscan: number): RowRange {
  const total = offsets[offsets.length - 1] ?? 0;
  return rangeFor(offsets, Math.max(0, total - height), total, overscan);
}

export function sameRange(a: RowRange, b: RowRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * How far the content under the reader moved when rows changed size: the sum
 * of the changes to rows that ended above the viewport's top edge. A row that
 * is on screen, even partly, is not counted, so expanding something the reader
 * is looking at grows it downwards rather than shoving it up.
 */
export function shiftAbove(changes: Array<{ oldBottom: number; delta: number }>, viewTop: number): number {
  let shift = 0;
  for (const c of changes) if (c.oldBottom <= viewTop) shift += c.delta;
  return shift;
}

/** Distance from the bottom within which the reader counts as following along. */
export const PIN_THRESHOLD = 80;

export function isPinned(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < PIN_THRESHOLD;
}
