/**
 * Run `fn` once the next frame has been produced.
 *
 * Opening a chat is a click, and React runs the effects of a click's update
 * before the browser paints. Work that only needs to be under way (a fetch, a
 * focus, unmounting what just left the screen) waits for the frame instead: a
 * requestAnimationFrame lands in the frame's own rendering step, and the task
 * it posts runs after that frame is out. Returns a cancel for effect cleanups.
 */
export function afterPaint(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(fn, 0);
  });
  return () => {
    cancelAnimationFrame(frame);
    if (timer != null) clearTimeout(timer);
  };
}
