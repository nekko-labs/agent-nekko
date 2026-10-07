#!/usr/bin/env node
/**
 * The speed contract, measured.
 *
 * Drives the web edition (built with `npm run build:web`) in headless Chromium
 * over the DevTools protocol, against a scripted model and a scratch data dir
 * seeded with a 1,000-message chat and a dozen others, and checks the p95 of
 * each interaction against the budgets in SPEC.md ("Speed & responsiveness").
 * By default a run is judged against the CI regression gate (twice the SPEC
 * target, see budgets.mjs); --strict judges against the targets themselves.
 *
 *   node scripts/perf/run.mjs [--out perf-results] [--quick] [--report-only]
 *
 * --quick        fewer samples, for iterating locally
 * --strict       judge against the SPEC targets (real hardware at 120 Hz), not the CI gate
 * --no-gpu       run the browsers without GPU emulation (for runners with no GPU)
 * --attempts <n> measure again (up to n runs) when a budget is missed, judging each
 *                budget on its best attempt; every attempt's p95 is reported
 * --report-only  write the report but exit 0 even when a budget is missed
 * --dump-trace   also write the streaming trace (large) to the output directory
 * --only <part>  run just 'latency' (keypress, switching) or 'frames' (streaming)
 * --profile      write a CPU profile and a main-thread trace of each switch phase
 *                and print where the time went
 * --timeline     only the main-thread traces of --profile (no CPU profiler overhead)
 * --debug        forward the page's console to this one
 * --app <dir>    measure the web edition built in another checkout (before/after)
 * PERF_BROWSER   path to a Chromium binary, when auto-detection picks wrong
 *
 * Latency budgets (keypress, switching) run in a browser with the frame-rate
 * limiter off, so a sample is the app's work rather than the wait for a
 * virtual 60 Hz vsync. Frame work while streaming runs in a second, ordinary
 * vsync-paced browser: with the limiter off, CSS animations alone would fill
 * every idle moment with frames and the per-frame figure would stop meaning
 * anything.
 *
 * Writes perf-report.json and perf-report.md to the output directory and exits
 * 1 when any budget is exceeded (2 when the run itself failed).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { connectCdp } from './lib/cdp.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { startMockProvider, STREAM_TRIGGER } from './lib/mock-provider.mjs';
import { seedDataDir, chatTitle, lastMarker } from './lib/seed.mjs';
import { INSTALL, locate } from './lib/probes.mjs';
import { summarize } from './lib/stats.mjs';
import { frameWorkFromTrace } from './lib/trace.mjs';
import { BUDGETS } from './budgets.mjs';
import { startProfile, startTimeline, stopProfile } from './lib/profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const QUICK = flag('quick');
const OUT = resolve(opt('out', join(ROOT, 'perf-results')));
// The checkout whose web edition is measured: this one, or another (a base
// branch built alongside, for before/after numbers).
const APP_ROOT = resolve(opt('app', ROOT));
const CFG = {
  // Chat 0 is the 1,000-message chat the composer and streaming budgets use;
  // the rest are switch targets, more of them than the warm set can hold.
  chats: [1000, ...Array(12).fill(400)],
  tokensPerSecond: 300,
  replyTokens: 7000,
  keySamples: QUICK ? 40 : 150,
  keyGapMs: 45,
  termSamples: QUICK ? 30 : 100,
  warmSwitches: QUICK ? 10 : 40,
  coldCycles: QUICK ? 1 : 3,
  traceSeconds: QUICK ? 3 : 6,
  viewport: { width: 1440, height: 1000 },
  mockPort: Number(opt('mock-port', 4391)),
  appPort: Number(opt('app-port', 4392)),
  cdpPort: Number(opt('cdp-port', 9391)),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[perf]', ...a);

const cleanups = [];
const cleanup = async () => {
  while (cleanups.length) {
    try { await cleanups.pop()(); } catch { /* best effort */ }
  }
};
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

/**
 * The chats the Command Center's wall should show, set once the data dir is
 * seeded. The wall remembers itself in localStorage and seeds a fresh profile
 * with at most a handful of recent chats, so the harness writes every seeded
 * chat onto it before the page loads and opens them from there.
 */
let WALL_IDS = [];
/** The wall as `commandWall.ts` saves it: a column of rows of four chat windows, no panels, auto-add off. */
const wallState = (ids) => {
  let seq = 0;
  const pane = (refId) => ({ id: `pane_${(++seq).toString(36)}`, kind: 'chat', refId });
  const rows = [];
  for (let i = 0; i < ids.length; i += 4) {
    const slice = ids.slice(i, i + 4).map(pane);
    rows.push(slice.length === 1 ? slice[0] : { id: `split_${(++seq).toString(36)}`, dir: 'row', children: slice, sizes: slice.map(() => 1 / slice.length) });
  }
  const root = rows.length === 0 ? null : rows.length === 1 ? rows[0] : { id: `split_${(++seq).toString(36)}`, dir: 'col', children: rows, sizes: rows.map(() => 1 / rows.length) };
  return JSON.stringify({ layout: { mode: 'grid', cols: 3, rows: 2 }, dock: { side: 'right', show: false, panels: {}, minimized: {} }, root, autoAdd: false, filter: 'all', insights: { panels: {} }, watermark: Date.now() });
};

/** One browser on the app, with the handful of gestures the scenarios need. */
async function openApp({ appUrl, cdpPort, vsync }) {
  const browser = await launchBrowser({ port: cdpPort, ...CFG.viewport, vsync, gpu: !flag('no-gpu') });
  const cdp = await connectCdp(browser.wsUrl);
  const close = async () => { try { cdp.close(); } catch { /* gone */ } browser.proc.kill(); await sleep(300); };
  cleanups.push(close);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (flag('debug')) {
    cdp.on('Runtime.consoleAPICalled', (p) => console.log('[page]', p.args.map((a) => a.value ?? a.description ?? JSON.stringify(a.preview?.properties?.map((x) => `${x.name}=${x.value}`))).join(' ')));
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...CFG.viewport, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('nekko.commandWall', ${JSON.stringify(wallState(WALL_IDS))}); } catch {}` });
  await cdp.send('Page.navigate', { url: appUrl });

  const waitFor = async (expr, what, timeoutMs = 30000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await cdp.evaluate(expr)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const clickAt = async ({ x, y }) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  };
  /** Where a visible element is, polling for up to `tries` × 100 ms; null when it never shows. */
  const find = async (selector, text, tries = 100) => {
    let at = null;
    for (let i = 0; i < tries && !at; i++) {
      at = await cdp.call(locate, selector, text ?? null);
      if (!at) await sleep(100);
    }
    return at;
  };
  const clickEl = async (selector, text, what) => {
    const at = await find(selector, text);
    if (!at) throw new Error(`could not find ${what ?? `${selector} "${text}"`}`);
    await clickAt(at);
  };

  /**
   * Put the sidebar in the state where every chat's card can be seen: every
   * project group expanded. A stray click on a group header during a run
   * otherwise hides cards for the rest of it.
   */
  const showAllCards = () => cdp.evaluate(`(() => {
    for (const h of document.querySelectorAll('button[aria-expanded="false"][data-sidebar-group]')) h.click();
    return true;
  })()`);
  /** What the sidebar is showing, for the error when a card cannot be found. */
  const sidebarState = () => cdp.evaluate(`(() => ({
    groups: [...document.querySelectorAll('button[data-sidebar-group]')].map((h) => h.textContent.trim() + ':' + h.getAttribute('aria-expanded')),
    cards: [...document.querySelectorAll('div[role="button"]')].map((c) => c.getAttribute('title')).filter(Boolean),
    completed: [...document.querySelectorAll('[data-completed-row]')].length,
  }))()`);

  await waitFor(`!!document.querySelector('nav button[aria-label="Agents"]')`, 'the app shell');
  await cdp.evaluate(INSTALL);

  /** Open a seeded chat from the Command Center (setup, not measured). */
  /** `marker` is what the newest reply must contain; '' accepts any (a chat that has grown since seeding). */
  const openChat = async (i, marker = lastMarker(i)) => {
    await clickEl('nav button[aria-label="Agents"]', null, 'the Command Center nav');
    const title = chatTitle(i);
    // Setup selects the exact grouped card on Agents; Chat no longer owns this list.
    await waitFor("!!document.querySelector('button[data-sidebar-group]')", 'the Agents sidebar');
    await showAllCards();
    await cdp.call((title) => [...document.querySelectorAll('div[role="button"]')].find(card => card.getAttribute('title')?.includes(title))?.click(), title);
    // Setup is not a measured sidebar switch. Let the virtual transcript settle
    // at its newest screenful; measured switchChat below receives no such help.
    await waitFor("!!document.querySelector('.msg-ai')", 'loaded setup transcript');
    for (let attempt = 0; attempt < 10; attempt++) {
      const settled = await cdp.call((t, m) => {
        const p = window.__perf.panel(t);
        const newest = [...(p?.querySelectorAll('.msg-ai') ?? [])].pop();
        const scroller = newest?.closest('.overflow-y-auto');
        if (!scroller) return false;
        const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2;
        if (atBottom && (!m || newest.textContent.includes(m))) return true;
        scroller.scrollTop = scroller.scrollHeight;
        return false;
      }, title, marker);
      if (settled) break;
      await sleep(100);
    }
    const ok = await cdp.call((t, m) => window.__perf.waitForChat(t, m, 30000), title, marker);
    if (!ok) {
      const seen = await cdp.call((t, m) => {
        const p = window.__perf.panel(t);
        const ai = p ? [...p.querySelectorAll('.msg-ai')] : [];
        const last = ai.pop();
        const s = last?.closest('.overflow-y-auto') ?? p?.querySelector('.overflow-y-auto');
        const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; };
        return { panel: !!p, visible: p?.checkVisibility(), rows: p?.querySelectorAll('[data-vt-key]').length,
          last: last?.textContent.slice(0, 80), textLength: last?.textContent.length, markerPresent: last?.textContent.includes(m),
          panelRect: rect(p), replyRect: rect(last), scrollerRect: rect(s),
          scrollHeight: s?.scrollHeight, scrollTop: s?.scrollTop, clientHeight: s?.clientHeight,
          gap: s ? s.scrollHeight - s.scrollTop - s.clientHeight : null };
      }, title, marker);
      throw new Error(`${title} never showed its newest message: ${JSON.stringify(seen)}`);
    }
  };

  /** Click a chat's sidebar card and report when its frame and newest reply painted. */
  const switchTo = async (i) => {
    await cdp.call((t, m) => window.__perf.armSwitch(t, m), chatTitle(i), lastMarker(i));
    const title = chatTitle(i);
    // Setup navigation leaves the pointer over the expanding app rail, which
    // can cover the Agents sidebar. Move off it before locating a measured card.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CFG.viewport.width - 20, y: 20 });
    await sleep(350);
    let at = await find('div[role="button"]', title, 30);
    if (!at) {
      // The card is there but hidden in a collapsed group. Active chats without
      // an open window are cards too, so there is no second list to fall back to.
      await showAllCards();
      at = await find('div[role="button"]', title, 20);
    }
    if (!at) throw new Error(`could not find the sidebar card for ${title}: ${JSON.stringify(await sidebarState())}`);
    // Scroll/reflow may move the sidebar row after locate scrolls it. Resolve
    // its final hit point before dispatching the measured input event.
    await cdp.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    at = await cdp.call(locate, 'div[role="button"]', title);
    if (!at) throw new Error('sidebar card disappeared before measured switch: ' + title);
    await clickAt(at);
    let res = null;
    for (let k = 0; k < 800 && !res; k++) {
      res = await cdp.evaluate('window.__perf.switchResult');
      if (!res) await sleep(25);
    }
    if (!res || res.timeout) {
      const seen = await cdp.call((marker) => [...document.querySelectorAll('.panel')].map((p) => ({
        title: p.firstElementChild?.querySelector('span.truncate')?.textContent,
        visible: p.checkVisibility(),
        composer: !!p.querySelector('textarea, .composer [contenteditable]')?.checkVisibility(),
        newest: p.textContent.includes(marker),
      })), lastMarker(i));
      throw new Error(`switch to ${chatTitle(i)} did not paint (${JSON.stringify(res)}): ${JSON.stringify(seen)}`);
    }
    // Let the arrival settle (fetches, effects) before the next measurement.
    await sleep(350);
    return res;
  };

  /** Send the long-reply prompt from the focused chat's composer. */
  const startStream = async (mock) => {
    const before = mock.state.streamsStarted;
    await clickEl('textarea, .composer [contenteditable]', null, 'the composer');
    await cdp.send('Input.insertText', { text: `${STREAM_TRIGGER} write the long report` });
    await sleep(200);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const t = Date.now();
    while (mock.state.streamsStarted === before && Date.now() - t < 20000) await sleep(50);
    if (mock.state.streamsStarted === before) throw new Error('the reply never started streaming');
    // Past the first paint of the live bubble, into the steady state.
    await sleep(1500);
    // The measurement means nothing unless tokens are actually landing on screen.
    const shown = () => cdp.evaluate(`(() => {
      const panel = [...document.querySelectorAll('.panel')].find((p) => p.querySelector('textarea, .composer [contenteditable]')?.checkVisibility());
      const all = panel ? panel.querySelectorAll('.msg-ai') : [];
      return all.length ? all[all.length - 1].textContent.length : 0;
    })()`);
    const a = await shown();
    await sleep(400);
    const b = await shown();
    if (!(b > a)) throw new Error(`the reply is not streaming onto the screen (${a} -> ${b} chars)`);
  };

  return { cdp, browser, close, waitFor, clickEl, openChat, switchTo, startStream };
}

/**
 * Keypress and switching latency, in a browser with the frame-rate limiter
 * off. The chats are opened as workspaces first, oldest first, so the big
 * chat ends up active.
 */
async function measureLatency({ appUrl, mock, api, bigChat }) {
  const app = await openApp({ appUrl, cdpPort: CFG.cdpPort, vsync: false });
  log(`browser ${app.browser.version || app.browser.bin}`);

  log('opening workspaces');
  for (let i = CFG.chats.length - 1; i >= 0; i--) await app.openChat(i);
  await sleep(1000);

  // Warm: back and forth between two chats seen a moment ago.
  log('warm switches');
  await app.switchTo(1);
  await app.switchTo(0);
  const warm = [];
  const warmTimeline = flag('profile') || flag('timeline') ? await startTimeline(app.cdp) : null;
  if (flag('profile')) await startProfile(app.cdp);
  for (let k = 0; k < CFG.warmSwitches; k++) warm.push((await app.switchTo(k % 2 === 0 ? 1 : 0)).history);
  if (flag('profile')) await stopProfile(app.cdp, OUT, 'warm-switch');
  if (warmTimeline) await warmTimeline(OUT, 'warm-switch');

  // Cold: cycle through more chats than the warm set holds, so every target
  // was last seen longer ago than anything kept warm. One unmeasured cycle
  // first flushes whatever setup left warm.
  log('cold switches');
  const ring = CFG.chats.map((_, i) => i).filter((i) => i >= 2);
  for (const i of ring) await app.switchTo(i);
  const coldFrame = [];
  const coldHistory = [];
  const coldTimeline = flag('profile') || flag('timeline') ? await startTimeline(app.cdp) : null;
  if (flag('profile')) await startProfile(app.cdp);
  for (let c = 0; c < CFG.coldCycles; c++) {
    for (const i of ring) {
      const r = await app.switchTo(i);
      coldFrame.push(r.frame);
      coldHistory.push(r.history);
    }
  }
  if (flag('profile')) await stopProfile(app.cdp, OUT, 'cold-switch');
  if (coldTimeline) await coldTimeline(OUT, 'cold-switch');

  // Composer: type into the 1,000-message chat while its reply streams.
  log(`typing ${CFG.keySamples} keys while a reply streams`);
  await app.switchTo(0);
  await app.startStream(mock);
  await app.cdp.evaluate('window.__perf.keys.length = 0; window.__perf.recordEvents = true;');
  const typingTimeline = flag('profile') || flag('timeline') ? await startTimeline(app.cdp) : null;
  if (flag('profile')) await startProfile(app.cdp);
  const text = 'the quick brown fox jumps over the lazy dog ';
  for (let k = 0; k < CFG.keySamples; k++) {
    const ch = text[k % text.length];
    const code = ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`;
    const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
    await sleep(CFG.keyGapMs);
  }
  if (flag('profile')) await stopProfile(app.cdp, OUT, 'typing');
  if (typingTimeline) await typingTimeline(OUT, 'typing');
  await sleep(300);
  const { keys, eventTiming } = await app.cdp.evaluate('({ keys: window.__perf.keys, eventTiming: window.__perf.eventTiming })');
  const typedWhileStreaming = mock.state.streamsFinished === 0;
  await api('chat:abort', bigChat);

  // Terminal: open one beside the chat (Ctrl+J, the app's own shortcut) and
  // type into it. The web edition's terminal is the TS host's pty, its output
  // riding the event bus to the pane.
  log(`typing ${CFG.termSamples} keys into a terminal`);
  const term = await measureTerminal(app);
  await app.close();
  await sleep(1000);
  return { browser: app.browser.version, warm, coldFrame, coldHistory, keys, eventTiming, typedWhileStreaming, term };
}

/** Keypress to the frame that draws its echo, in a terminal pane. */
async function measureTerminal(app) {
  const ctrl = { modifiers: process.platform === 'darwin' ? 4 : 2 };
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, ...ctrl });
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', windowsVirtualKeyCode: 74, ...ctrl });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = await app.cdp.evaluate(`!!document.querySelector('.xterm-helper-textarea')`);
    if (!ready) await sleep(100);
  }
  if (!ready) return { skipped: 'no terminal pane opened (does this machine have a shell the host can start?)' };
  // Let the shell print its prompt and settle before timing anything.
  await sleep(2500);
  await app.cdp.evaluate(`document.querySelector('.xterm-helper-textarea').focus(); window.__perf.term.length = 0; window.__perf.termEcho.length = 0; 1`);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (let k = 0; k < CFG.termSamples; k++) {
    const ch = letters[k % letters.length];
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: `Key${ch.toUpperCase()}`, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}`, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
    await sleep(CFG.keyGapMs + 15);
    // Keep the line short so the shell never wraps: Ctrl+C drops it in bash,
    // zsh and PowerShell alike, then the new prompt is left to settle.
    if (k % 20 === 19) {
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, ...ctrl });
      await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, ...ctrl });
      await sleep(500);
    }
  }
  await sleep(400);
  return { samples: await app.cdp.evaluate('window.__perf.term.slice()'), echo: await app.cdp.evaluate('window.__perf.termEcho.slice()') };
}

/** Main-thread work per frame while the big chat streams, in a vsync-paced browser. */
async function measureFrames({ appUrl, mock, api, bigChat }) {
  log(`tracing ${CFG.traceSeconds}s of streaming in a vsync-paced browser`);
  const paced = await openApp({ appUrl, cdpPort: CFG.cdpPort + 1, vsync: true });
  // The latency phase left a reply of its own at the end of this chat.
  await paced.openChat(0, '');
  await paced.startStream(mock);
  const traceEvents = [];
  const offData = paced.cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value) traceEvents.push(e); });
  const traced = new Promise((r) => { const off = paced.cdp.on('Tracing.tracingComplete', () => { off(); r(); }); });
  await paced.cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline.frame', '__metadata'],
    },
  });
  if (flag('profile')) await startProfile(paced.cdp);
  await sleep(CFG.traceSeconds * 1000);
  if (flag('profile')) await stopProfile(paced.cdp, OUT, 'streaming');
  const tracedWhileStreaming = mock.state.streamsFinished === 0;
  await paced.cdp.send('Tracing.end');
  await traced;
  offData();
  if (flag('dump-trace')) writeFileSync(join(OUT, 'trace.json'), JSON.stringify({ traceEvents }));
  await api('chat:abort', bigChat);
  await paced.close();
  return { browser: paced.browser.version, tracedWhileStreaming, ...frameWorkFromTrace(traceEvents) };
}

/**
 * Put a seeded chat back as it was: the streaming phases append a prompt and
 * a reply to it, and the next attempt expects its seeded newest message.
 */
async function resetChat(api, id, seeded) {
  const s = await (await api('session:get', id)).json();
  const extra = s?.messages?.[seeded];
  if (extra) await api('session:truncate', id, extra.id);
}

/** One attempt's samples per budget. */
function resultsOf(latency, frames) {
  return {
    composer_keypress: latency
      ? { samples: latency.keys, note: latency.typedWhileStreaming ? 'typed while the reply streamed' : 'WARNING: the reply finished before typing did' }
      : { skipped: 'not run (--only frames)' },
    terminal_keypress: !latency
      ? { skipped: 'not run (--only frames)' }
      : latency.term.skipped
        ? { skipped: latency.term.skipped }
        : {
          samples: latency.term.samples,
          note: `the web edition's terminal: the TS host's pty, output over the event bus, drawn by the pane's xterm; the echo itself reached the page at p50 ${summarize(latency.term.echo ?? []).p50 ?? '-'} ms`,
        },
    stream_frame_work: frames
      ? { samples: frames.work, note: `${frames.frames} frames over ${CFG.traceSeconds}s at ${CFG.tokensPerSecond} tok/s, main thread ${Math.round(frames.busyFraction * 100)}% busy (${frames.source})${frames.tracedWhileStreaming ? '' : '; WARNING: the reply finished mid-trace'}` }
      : { skipped: 'not run (--only latency)' },
    warm_switch: latency ? { samples: latency.warm } : { skipped: 'not run (--only frames)' },
    cold_switch_frame: latency ? { samples: latency.coldFrame } : { skipped: 'not run (--only frames)' },
    cold_switch_history: latency ? { samples: latency.coldHistory } : { skipped: 'not run (--only frames)' },
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const mock = await startMockProvider({ port: CFG.mockPort, tokensPerSecond: CFG.tokensPerSecond, replyTokens: CFG.replyTokens });
  cleanups.push(() => mock.close());

  const { dir: dataDir, ids } = seedDataDir({ mockPort: CFG.mockPort, chats: CFG.chats });
  WALL_IDS = ids;
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  log(`scratch data dir ${dataDir}`);

  const server = spawn(process.execPath, [join(APP_ROOT, 'apps/server/dist/index.js')], {
    cwd: APP_ROOT,
    env: { ...process.env, NEKKO_DATA_DIR: dataDir, NEKKO_PORT: String(CFG.appPort), NEKKO_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  cleanups.push(() => server.kill());
  const appUrl = `http://127.0.0.1:${CFG.appPort}/`;
  const api = (channel, ...args) =>
    fetch(`${appUrl}api/${channel}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await api('settings:get')).ok; } catch { /* starting */ }
    if (!up) await sleep(250);
  }
  if (!up) throw new Error(`web edition did not start:\n${serverLog.slice(-2000)}`);

  const only = opt('only', null);
  const strict = flag('strict');
  // A shared CI runner has noisy neighbours: with --attempts N, a run that
  // misses a budget is measured again, and each budget is judged on its best
  // attempt. Every attempt's p95 stays in the report, so a real regression
  // (one that misses every time) still shows, and still fails.
  const attempts = Math.max(1, Number(opt('attempts', 1)));
  const tries = [];
  let rows = [];
  let latency = null;
  let frames = null;
  for (let a = 0; a < attempts; a++) {
    if (a > 0) log(`a budget was missed; measuring again (attempt ${a + 1} of ${attempts})`);
    latency = only === 'frames' ? null : await measureLatency({ appUrl, mock, api, bigChat: ids[0] });
    frames = only === 'latency' ? null : await measureFrames({ appUrl, mock, api, bigChat: ids[0] });
    tries.push(resultsOf(latency, frames));
    await resetChat(api, ids[0], CFG.chats[0]);
    rows = BUDGETS.map((b) => {
      const budget = strict ? b.target : b.ci;
      const measured = tries.map((t) => t[b.id]).filter((r) => !r.skipped);
      if (!measured.length) return { ...b, budget, skipped: tries[tries.length - 1][b.id].skipped, pass: true };
      const all = measured.map((r) => ({ r, s: summarize(r.samples) }));
      const best = all.reduce((x, y) => ((y.s.p95 ?? Infinity) < (x.s.p95 ?? Infinity) ? y : x));
      return {
        ...b, budget, ...best.s, note: best.r.note,
        attempts: all.map((x) => x.s.p95),
        pass: best.s.p95 != null && best.s.p95 <= budget,
      };
    });
    if (rows.every((r) => r.pass)) break;
  }
  const browserVersion = latency?.browser ?? frames?.browser ?? '';
  const results = tries[tries.length - 1];

  // ------------------------------------------------------------------ report
  const report = {
    at: new Date().toISOString(),
    git: process.env.GITHUB_SHA ?? null,
    machine: { platform: process.platform, cpus: os.cpus().length, cpu: os.cpus()[0]?.model?.trim(), memGb: Math.round(os.totalmem() / 2 ** 30) },
    browser: browserVersion,
    config: CFG,
    judgedAgainst: strict ? 'SPEC target (--strict)' : 'CI regression gate (2x the SPEC target)',
    attempts: tries.length,
    budgets: rows,
    eventTiming: {
      note: 'Event Timing entries at or above 16 ms (the API minimum) recorded while typing',
      count: latency?.eventTiming.length ?? 0,
      max: (latency?.eventTiming ?? []).reduce((m, e) => Math.max(m, e.duration), 0),
    },
    samples: Object.fromEntries(
      Object.entries(results).filter(([, r]) => r.samples).map(([k, r]) => [k, r.samples.map((v) => Math.round(v * 100) / 100)]),
    ),
  };
  writeFileSync(join(OUT, 'perf-report.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'perf-report.md'), markdown(report));
  console.log(`\n${markdown(report)}`);
  return rows.every((r) => r.pass);
}

function markdown(report) {
  const fmt = (v) => (v == null ? '-' : `${v.toFixed(1)} ms`);
  return [
    '## Speed contract',
    '',
    `${report.machine.cpu ?? 'unknown CPU'} (${report.machine.cpus} threads), ${report.machine.platform}, ${report.browser}`,
    '',
    `Judged against: ${report.judgedAgainst}.`,
    '',
    '| Interaction | SPEC target | CI gate | Judged against | p50 | p95 | max | n | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.budgets.map((b) =>
      b.skipped
        ? `| ${b.label} | ${b.target} ms | ${b.ci} ms | ${b.budget} ms | - | - | - | - | skipped |`
        : `| ${b.label} | ${b.target} ms | ${b.ci} ms | ${b.budget} ms | ${fmt(b.p50)} | ${fmt(b.p95)} | ${fmt(b.max)} | ${b.n} | ${b.pass ? 'pass' : '**FAIL**'} |`,
    ),
    '',
    ...report.budgets.filter((b) => b.skipped || b.note).map((b) => `- ${b.label}: ${b.skipped ?? b.note}`),
    ...(report.attempts > 1
      ? [`- Measured ${report.attempts} times; each row shows its best attempt. p95 per attempt: ${report.budgets.filter((b) => b.attempts).map((b) => `${b.id} ${b.attempts.map((v) => (v == null ? '-' : v.toFixed(1))).join(' / ')}`).join('; ')}`]
      : []),
    `- Event Timing entries of 16 ms or more while typing: ${report.eventTiming.count} (max ${report.eventTiming.max.toFixed(0)} ms)`,
    '',
  ].join('\n');
}

main()
  .then(async (ok) => {
    await cleanup();
    if (!ok && !flag('report-only')) {
      console.error('[perf] a budget was exceeded');
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('[perf] failed:', e);
    await cleanup();
    process.exit(2);
  });
