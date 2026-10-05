import { afterEach, expect, it, vi } from 'vitest';
import { dockMinimizeTransition } from './dockMinimize.js';
afterEach(() => vi.useRealTimers());
it('keeps the panel in its animated state until 220ms', () => {
  vi.useFakeTimers(); const t = dockMinimizeTransition(), animate = vi.fn(), commit = vi.fn();
  t.start(false, animate, commit); expect(animate).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(219); expect(commit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(commit).toHaveBeenCalledOnce();
});
it('commits reduced motion immediately without animation', () => {
  const t = dockMinimizeTransition(), animate = vi.fn(), commit = vi.fn();
  t.start(true, animate, commit); expect(animate).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledOnce();
});
it('cancels pending work on disposal or a subsequent transition', () => {
  vi.useFakeTimers(); const t = dockMinimizeTransition(), stale = vi.fn(), current = vi.fn();
  t.start(false, vi.fn(), stale); t.start(false, vi.fn(), current);
  vi.advanceTimersByTime(220); expect(stale).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledOnce();
  t.start(false, vi.fn(), stale); t.cancel(); vi.runAllTimers(); expect(stale).not.toHaveBeenCalled();
});
