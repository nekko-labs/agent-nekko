/** Owns the one pending minimize transition; cancellation never commits stale state. */
export function dockMinimizeTransition() {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  return {
    cancel,
    start(reducedMotion: boolean, animate: () => void, commit: () => void) {
      cancel();
      if (reducedMotion) { commit(); return; }
      animate();
      timer = setTimeout(() => { timer = null; commit(); }, 220);
    },
  };
}
