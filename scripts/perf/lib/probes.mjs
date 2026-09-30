/**
 * Code the harness injects into the page. Each probe measures in the page's own
 * clock: from the input event's timestamp (when the browser received it) to
 * the end of the first frame that shows the effect.
 *
 * "End of the frame" is a requestAnimationFrame callback followed by a
 * MessageChannel tick: the rAF runs in the frame's rendering step, style,
 * layout and paint follow it in the same task, and the posted message runs in
 * the next task, after the frame has been produced.
 */

/** Pure DOM helpers shared by the probes, as page-side source. */
const HELPERS = String.raw`
  const afterFrame = (fn) => requestAnimationFrame(() => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => fn(performance.now());
    ch.port2.postMessage(0);
  });
  // The on-screen window whose title strip reads "title" and whose composer is
  // visible: that is the chat's frame, painted.
  const visiblePanel = (title) => {
    for (const ta of document.querySelectorAll('textarea')) {
      if (!ta.checkVisibility()) continue;
      const panel = ta.closest('.panel');
      const strip = panel && panel.firstElementChild && panel.firstElementChild.querySelector('span.truncate');
      if (strip && strip.textContent === title) return panel;
    }
    return null;
  };
  // The newest assistant reply is laid out and inside the transcript's viewport.
  const newestVisible = (panel, marker) => {
    const all = panel.querySelectorAll('.msg-ai');
    const last = all[all.length - 1];
    if (!last || !last.textContent.includes(marker)) return false;
    const r = last.getBoundingClientRect();
    const sc = last.closest('.overflow-y-auto');
    const v = sc ? sc.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    return r.height > 0 && r.bottom > v.top && r.top < v.bottom;
  };
`;

export const INSTALL = String.raw`(() => {
  if (window.__perf) return true;
  ${HELPERS}
  const P = (window.__perf = { keys: [], eventTiming: [] });

  // --- Keypress to paint in a textarea ---
  let keyAt = null;
  const isTerminal = (el) => !!(el && el.classList && el.classList.contains('xterm-helper-textarea'));
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'TEXTAREA' && !isTerminal(e.target) && e.key.length === 1) keyAt = e.timeStamp;
  }, true);
  // Registered from the input event, which is where the value (and React's
  // controlled state) changes, so the frame that follows includes the commit.
  document.addEventListener('input', (e) => {
    if (keyAt == null || !e.target || e.target.tagName !== 'TEXTAREA') return;
    const start = keyAt;
    keyAt = null;
    afterFrame((now) => P.keys.push(now - start));
  }, true);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!P.recordEvents) continue;
        P.eventTiming.push({ name: e.name, duration: e.duration, processing: e.processingEnd - e.processingStart });
      }
    }).observe({ type: 'event', durationThreshold: 16 });
  } catch { /* Event Timing unavailable */ }

  // --- Keypress to paint in a terminal ---
  // Timed to the frame after the echo is drawn: the key goes to the pty, the
  // shell echoes it back as terminal output, the pane hands that to xterm, and
  // xterm draws it on its next animation frame. Two task hops let the pane's
  // own listener (registered after this one) and xterm's write queue run
  // first, so the frame measured is the one that shows the character.
  P.term = [];
  let termKey = null;
  document.addEventListener('keydown', (e) => {
    if (isTerminal(e.target) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) termKey = { at: e.timeStamp, ch: e.key };
  }, true);
  if (window.nekko && window.nekko.onTerminalEvent) {
    window.nekko.onTerminalEvent((ev) => {
      if (!termKey || ev.type !== 'data' || !ev.data.includes(termKey.ch)) return;
      const start = termKey.at;
      termKey = null;
      setTimeout(() => setTimeout(() => afterFrame((now) => P.term.push(now - start)), 0), 0);
    });
  }

  /** Resolve once a chat's frame and newest reply are both painted. */
  P.waitForChat = (title, marker, timeoutMs = 20000) => new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const loop = () => requestAnimationFrame(() => {
      const panel = visiblePanel(title);
      if (panel && newestVisible(panel, marker)) return resolve(true);
      if (performance.now() > deadline) return resolve(false);
      loop();
    });
    loop();
  });

  /**
   * Arm a switch measurement: the next click starts the clock, and the result
   * records when the target chat's frame, then its newest reply, first painted.
   */
  P.armSwitch = (title, marker, timeoutMs = 15000) => {
    P.switchResult = null;
    let start = null;
    let sawFrame = false;
    let sawHistory = false;
    const res = {};
    const finish = () => { P.switchResult = res; };
    const loop = () => requestAnimationFrame(() => {
      const panel = visiblePanel(title);
      const frameNow = !sawFrame && !!panel;
      const historyNow = !sawHistory && !!panel && newestVisible(panel, marker);
      if (frameNow) sawFrame = true;
      if (historyNow) sawHistory = true;
      if (frameNow || historyNow) {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => {
          const d = performance.now() - start;
          if (frameNow) res.frame = d;
          if (historyNow) res.history = d;
          if (res.frame != null && res.history != null) finish();
        };
        ch.port2.postMessage(0);
      }
      if (sawFrame && sawHistory) return;
      if (performance.now() - start > timeoutMs) { res.timeout = true; finish(); return; }
      loop();
    });
    document.addEventListener('click', (e) => { start = e.timeStamp; loop(); }, { capture: true, once: true });
  };
  /** The window whose title strip reads "title", visible or not. */
  P.panel = (title) => [...document.querySelectorAll('.panel')]
    .find((p) => p.firstElementChild && p.firstElementChild.querySelector('span.truncate')?.textContent === title) ?? null;
  return true;
})()`;

/**
 * Center of the first visible element matching `selector` whose title (or
 * text) is `text` (any, when null), scrolled into view. A page function, for
 * `cdp.call(locate, selector, text)`.
 */
export function locate(selector, text) {
  const el = [...document.querySelectorAll(selector)]
    .find((x) => x.checkVisibility() && (text == null || (x.getAttribute('title') ?? x.textContent ?? '').trim() === text));
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 12)) };
}
