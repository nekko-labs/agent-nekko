import { useEffect, useState } from 'react';

/**
 * The measured width of an element, for layout decisions a CSS breakpoint can't
 * make: inside a splittable workbench, "is there room" is a question about the
 * pane, and the viewport can't answer it. Returns 0 until the first measurement,
 * so callers should treat 0 as "narrow" and let the real value arrive.
 */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
