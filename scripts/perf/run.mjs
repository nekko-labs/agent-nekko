#!/usr/bin/env node
/**
 * The speed contract, measured.
 *
 * Drives the web edition (built with `npm run build:web`) in headless Chromium
 * over the DevTools protocol, against a scripted model and a scratch data dir
 * seeded with a 1,000-message chat and a dozen others, and checks the p95 of
 * each interaction against the budgets in SPEC.md ("Speed & responsiveness").
 *
 *   node scripts/perf/run.mjs [--out perf-results] [--quick] [--report-only]
 *
 * --quick        fewer samples, for iterating locally
 * --report-only  write the report but exit 0 even when a budget is missed
 * --dump-trace   also write the streaming trace (large) to the output directory
 * --only <part>  run just 'latency' (keypress, switching) or 'frames' (streaming)
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const QUICK = flag('quick');
const OUT = resolve(opt('out', join(ROOT, 'perf-results')));
const CFG = {
  // Chat 0 is the 1,000-message chat the composer and streaming budgets use;
  // the rest are switch targets, more of them than the warm set can hold.
  chats: [1000, ...Array(12).fill(400)],
  tokensPerSecond: 300,
  replyTokens: 7000,
  keySamples: QUICK ? 40 : 150,
  keyGapMs: 45,
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

/** One browser on the app, with the handful of gestures the scenarios need. */
async function openApp({ appUrl, cdpPort, vsync }) {
  const browser = await launchBrowser({ port: cdpPort, ...CFG.viewport, vsync });
  const cdp = await connectCdp(browser.wsUrl);
  const close = async () => { try { cdp.close(); } catch { /* gone */ } browser.proc.kill(); await sleep(300); };
  cleanups.push(close);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...CFG.viewport, deviceScaleFactor: 1, mobile: false });
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
  const clickEl = async (selector, text, what) => {
    let at = null;
    for (let i = 0; i < 100 && !at; i++) {
      at = await cdp.evaluate(locate(selector, text));
      if (!at) await sleep(100);
    }
    if (!at) throw new Error(`could not find ${what ?? `${selector} "${text}"`}`);
    await clickAt(at);
  };

  await waitFor(`!!document.querySelector('nav button[aria-label="Command Center"]')`, 'the app shell');
  await cdp.evaluate(INSTALL);

  /** Open a seeded chat from the Command Center (setup, not measured). */
  const openChat = async (i) => {
    await clickEl('nav button[aria-label="Command Center"]', null, 'the Command Center nav');
    const title = chatTitle(i);
    const openSel = `button[title="Open ${title}"]`;
    await waitFor(`!!document.querySelector('button[title^="Open Perf chat"]')`, 'session cards');
    if (!(await cdp.evaluate(`!!document.querySelector(${JSON.stringify(openSel)})`))) {
      await cdp.evaluate(`[...document.querySelectorAll('button')].filter((b) => /^Show all/.test(b.textContent.trim())).forEach((b) => b.click())`);
      await sleep(200);
    }
    await clickEl(openSel, null, `the card for ${title}`);
    const ok = await cdp.evaluate(`window.__perf.waitForChat(${JSON.stringify(title)}, ${JSON.stringify(lastMarker(i))}, 30000)`);
    if (!ok) throw new Error(`${title} never showed its newest message`);
  };

  /** Click a chat's sidebar card and report when its frame and newest reply painted. */
  const switchTo = async (i) => {
    await cdp.evaluate(`window.__perf.armSwitch(${JSON.stringify(chatTitle(i))}, ${JSON.stringify(lastMarker(i))})`);
    await clickEl('div[role="button"]', chatTitle(i), `the sidebar card for ${chatTitle(i)}`);
    let res = null;
    for (let k = 0; k < 800 && !res; k++) {
      res = await cdp.evaluate('window.__perf.switchResult');
      if (!res) await sleep(25);
    }
    if (!res || res.timeout) throw new Error(`switch to ${chatTitle(i)} did not paint`);
    // Let the arrival settle (fetches, effects) before the next measurement.
    await sleep(350);
    return res;
  };

  /** Send the long-reply prompt from the focused chat's composer. */
  const startStream = async (mock) => {
    const before = mock.state.streamsStarted;
    await clickEl('textarea', null, 'the composer');
    await cdp.send('Input.insertText', { text: `${STREAM_TRIGGER} write the long report` });
    await sleep(200);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    const t = Date.now();
    while (mock.state.streamsStarted === before && Date.now() - t < 20000) await sleep(50);
    if (mock.state.streamsStarted === before) throw new Error('the reply never started streaming');
    // Past the first paint of the live bubble, into the steady state.
    await sleep(1500);
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
  for (let k = 0; k < CFG.warmSwitches; k++) warm.push((await app.switchTo(k % 2 === 0 ? 1 : 0)).history);

  // Cold: cycle through more chats than the warm set holds, so every target
  // was last seen longer ago than anything kept warm. One unmeasured cycle
  // first flushes whatever setup left warm.
  log('cold switches');
  const ring = CFG.chats.map((_, i) => i).filter((i) => i >= 2);
  for (const i of ring) await app.switchTo(i);
  const coldFrame = [];
  const coldHistory = [];
  for (let c = 0; c < CFG.coldCycles; c++) {
    for (const i of ring) {
      const r = await app.switchTo(i);
      coldFrame.push(r.frame);
      coldHistory.push(r.history);
    }
  }

  // Composer: type into the 1,000-message chat while its reply streams.
  log(`typing ${CFG.keySamples} keys while a reply streams`);
  await app.switchTo(0);
  await app.startStream(mock);
  await app.cdp.evaluate('window.__perf.keys.length = 0; window.__perf.recordEvents = true;');
  const text = 'the quick brown fox jumps over the lazy dog ';
  for (let k = 0; k < CFG.keySamples; k++) {
    const ch = text[k % text.length];
    const code = ch === ' ' ? 'Space' : `Key${ch.toUpperCase()}`;
    const vk = ch === ' ' ? 32 : ch.toUpperCase().charCodeAt(0);
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk });
    await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code, windowsVirtualKeyCode: vk });
    await sleep(CFG.keyGapMs);
  }
  await sleep(300);
  const { keys, eventTiming } = await app.cdp.evaluate('({ keys: window.__perf.keys, eventTiming: window.__perf.eventTiming })');
  const typedWhileStreaming = mock.state.streamsFinished === 0;
  await api('chat:abort', bigChat);
  await app.close();
  await sleep(1000);
  return { browser: app.browser.version, warm, coldFrame, coldHistory, keys, eventTiming, typedWhileStreaming };
}

/** Main-thread work per frame while the big chat streams, in a vsync-paced browser. */
async function measureFrames({ appUrl, mock, api, bigChat }) {
  log(`tracing ${CFG.traceSeconds}s of streaming in a vsync-paced browser`);
  const paced = await openApp({ appUrl, cdpPort: CFG.cdpPort + 1, vsync: true });
  await paced.openChat(0);
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
  await sleep(CFG.traceSeconds * 1000);
  const tracedWhileStreaming = mock.state.streamsFinished === 0;
  await paced.cdp.send('Tracing.end');
  await traced;
  offData();
  if (flag('dump-trace')) writeFileSync(join(OUT, 'trace.json'), JSON.stringify({ traceEvents }));
  await api('chat:abort', bigChat);
  await paced.close();
  return { browser: paced.browser.version, tracedWhileStreaming, ...frameWorkFromTrace(traceEvents) };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const mock = await startMockProvider({ port: CFG.mockPort, tokensPerSecond: CFG.tokensPerSecond, replyTokens: CFG.replyTokens });
  cleanups.push(() => mock.close());

  const { dir: dataDir, ids } = seedDataDir({ mockPort: CFG.mockPort, chats: CFG.chats });
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  log(`scratch data dir ${dataDir}`);

  const server = spawn(process.execPath, [join(ROOT, 'apps/server/dist/index.js')], {
    cwd: ROOT,
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
  const latency = only === 'frames' ? null : await measureLatency({ appUrl, mock, api, bigChat: ids[0] });
  const frames = only === 'latency' ? null : await measureFrames({ appUrl, mock, api, bigChat: ids[0] });
  const browserVersion = latency?.browser ?? frames?.browser ?? '';

  // ------------------------------------------------------------------ report
  const results = {
    composer_keypress: latency
      ? { samples: latency.keys, note: latency.typedWhileStreaming ? 'typed while the reply streamed' : 'WARNING: the reply finished before typing did' }
      : { skipped: 'not run (--only frames)' },
    terminal_keypress: { skipped: 'the terminal is being rebuilt (PF7); its keypress probe lands with it' },
    stream_frame_work: frames
      ? { samples: frames.work, note: `${frames.frames} frames over ${CFG.traceSeconds}s at ${CFG.tokensPerSecond} tok/s, main thread ${Math.round(frames.busyFraction * 100)}% busy (${frames.source})${frames.tracedWhileStreaming ? '' : '; WARNING: the reply finished mid-trace'}` }
      : { skipped: 'not run (--only latency)' },
    warm_switch: latency ? { samples: latency.warm } : { skipped: 'not run (--only frames)' },
    cold_switch_frame: latency ? { samples: latency.coldFrame } : { skipped: 'not run (--only frames)' },
    cold_switch_history: latency ? { samples: latency.coldHistory } : { skipped: 'not run (--only frames)' },
  };
  const rows = BUDGETS.map((b) => {
    const r = results[b.id];
    if (r.skipped) return { ...b, skipped: r.skipped, pass: true };
    const s = summarize(r.samples);
    return { ...b, ...s, note: r.note, pass: s.p95 != null && s.p95 <= b.budget };
  });
  const report = {
    at: new Date().toISOString(),
    git: process.env.GITHUB_SHA ?? null,
    machine: { platform: process.platform, cpus: os.cpus().length, cpu: os.cpus()[0]?.model?.trim(), memGb: Math.round(os.totalmem() / 2 ** 30) },
    browser: browserVersion,
    config: CFG,
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
    '| Interaction | Budget | p50 | p95 | max | n | Result |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.budgets.map((b) =>
      b.skipped
        ? `| ${b.label} | ${b.budget} ms | - | - | - | - | skipped |`
        : `| ${b.label} | ${b.budget} ms | ${fmt(b.p50)} | ${fmt(b.p95)} | ${fmt(b.max)} | ${b.n} | ${b.pass ? 'pass' : '**FAIL**'} |`,
    ),
    '',
    ...report.budgets.filter((b) => b.skipped || b.note).map((b) => `- ${b.label}: ${b.skipped ?? b.note}`),
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
