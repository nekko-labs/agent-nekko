import { useEffect, useState } from 'react';

/** The last width measured per key, and overall, to start the next mount from. */
const remembered = new Map<string, number>();
let lastWidth = 0;

/**
 * The measured width of an element, for layout decisions a CSS breakpoint can't
 * make: inside a splittable workbench, "is there room" is a question about the
 * pane, and the viewport can't answer it.
 *
 * A mount starts from the width this `key` (a chat) last had, or from the last
 * width measured at all, and the ResizeObserver corrects it after layout. That
 * keeps opening a chat to one render: measuring synchronously on mount forced
 * a layout and a second full render of the pane before its first frame. With
 * nothing to go on yet it still measures synchronously, so the very first
 * pane is never laid out at the wrong width. Returns 0 until a width is known,
 * so callers should treat 0 as "narrow" and let the real value arrive.
 */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>, key?: string): number {
  const [width, setWidth] = useState(() => (key ? remembered.get(key) : undefined) ?? lastWidth);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A pane kept mounted behind the scenes measures 0 while hidden; keep the
    // last real width rather than re-laying it out as "narrow" unseen.
    const measure = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      lastWidth = w;
      if (key) remembered.set(key, w);
      setWidth(w);
    };
    if (!lastWidth) measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, key]);
  return width;
}

/** Under this width or height a chat folds its instrument strip into one summary chip. */
export const COMPACT_WIDTH = 470;
export const COMPACT_HEIGHT = 440;

/**
 * Whether the element is small enough to call for the compact chat chrome:
 * a cell on the Command Center wall, or a window split down to a sliver.
 * Width and height both count, since a wide but short window has no more
 * room for two rows of controls than a narrow one. False until measured, so a
 * pane opens at full size and folds only once it knows it must.
 */
export function useElementCompact(ref: React.RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      setCompact(w < COMPACT_WIDTH || h < COMPACT_HEIGHT);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return compact;
}
