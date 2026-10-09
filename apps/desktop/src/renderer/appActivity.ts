/**
 * Mark the document inactive while this window is hidden or not focused, so
 * the stylesheet can hold every looping decoration (working beams, rockets,
 * the needs-you glow, dots, the mascot) on its current frame.
 *
 * Chromium already throttles a hidden or fully covered window, but a window
 * left visible behind another app keeps compositing its animations at the
 * display's refresh rate, and on a Mac that is where the energy went: a wall
 * of working agents kept the GPU process busy all day. State is still shown
 * (the beam and rocket stay drawn, only still); motion resumes on focus.
 */
export function syncAppActivity(doc: Document = document, win: Pick<Window, 'addEventListener' | 'removeEventListener'> = window): () => void {
  const root = doc.documentElement;
  const update = () => {
    const active = doc.visibilityState === 'visible' && doc.hasFocus();
    if (active) delete root.dataset.appInactive;
    else root.dataset.appInactive = '';
  };
  update();
  win.addEventListener('focus', update);
  win.addEventListener('blur', update);
  doc.addEventListener('visibilitychange', update);
  return () => {
    win.removeEventListener('focus', update);
    win.removeEventListener('blur', update);
    doc.removeEventListener('visibilitychange', update);
    delete root.dataset.appInactive;
  };
}
