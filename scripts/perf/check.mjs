#!/usr/bin/env node
/**
 * A functional pass over what the speed work touched, in the same world the
 * harness measures: drafts surviving a switch and a reload, a streamed reply
 * that follows the bottom until you scroll up (and offers the jump pill when
 * you do), switching away and back mid-reply, and the finished reply landing
 * once. Prints PASS/FAIL per check and writes screenshots to --out.
 *
 *   node scripts/perf/check.mjs [--out perf-results/check] [--app <other checkout>]
 *
 * With --app it runs against another checkout's build, which is how the
 * screenshots get a "before" to compare with.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdp } from './lib/cdp.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { startMockProvider, STREAM_TRIGGER } from './lib/mock-provider.mjs';
import { seedDataDir, chatTitle, lastMarker } from './lib/seed.mjs';
import { INSTALL, locate } from './lib/probes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = resolve(opt('out', join(ROOT, 'perf-results', 'check')));
const APP_ROOT = resolve(opt('app', ROOT));
const PORTS = { mock: 4491, app: 4492, cdp: 9491 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

mkdirSync(OUT, { recursive: true });
const mock = await startMockProvider({ port: PORTS.mock, tokensPerSecond: 300, replyTokens: 3000 });
const { dir } = seedDataDir({ mockPort: PORTS.mock, chats: [1000, 400, 400] });
const server = spawn(process.execPath, [join(APP_ROOT, 'apps/server/dist/index.js')], {
  cwd: APP_ROOT,
  env: { ...process.env, NEKKO_DATA_DIR: dir, NEKKO_PORT: String(PORTS.app), NEKKO_HOST: '127.0.0.1' },
  stdio: 'ignore',
});
const appUrl = `http://127.0.0.1:${PORTS.app}/`;
for (let i = 0; i < 120; i++) {
  try { if ((await fetch(`${appUrl}api/settings:get`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}' })).ok) break; } catch { /* starting */ }
  await sleep(250);
}
const browser = await launchBrowser({ port: PORTS.cdp, width: 1440, height: 1000, vsync: true });
const cdp = await connectCdp(browser.wsUrl);
const cleanup = () => { try { cdp.close(); } catch {} browser.proc.kill(); server.kill(); mock.close(); setTimeout(() => rmSync(dir, { recursive: true, force: true }), 500); };

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const load = async () => {
    await cdp.send('Page.navigate', { url: appUrl });
    for (let i = 0; i < 100 && !(await cdp.evaluate(`!!document.querySelector('nav button[aria-label="Command Center"]')`)); i++) await sleep(100);
    await cdp.evaluate(INSTALL);
  };
  const click = async (selector, text) => {
    let at = null;
    for (let i = 0; i < 50 && !at; i++) { at = await cdp.evaluate(locate(selector, text)); if (!at) await sleep(100); }
    if (!at) throw new Error(`nothing to click: ${selector} ${text ?? ''}`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 });
  };
  const open = async (i) => {
    await click('nav button[aria-label="Command Center"]');
    await sleep(500);
    await click(`button[title="Open ${chatTitle(i)}"]`);
    return cdp.evaluate(`window.__perf.waitForChat(${JSON.stringify(chatTitle(i))}, ${JSON.stringify(lastMarker(i))}, 20000)`);
  };
  const shot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(s.data, 'base64'));
  };
  const composer = (title) => `[...document.querySelectorAll('.panel')].find((p) => p.firstElementChild?.querySelector('span.truncate')?.textContent === ${JSON.stringify(title)})?.querySelector('textarea')`;
  const scroller = (title) => `[...document.querySelectorAll('.panel')].find((p) => p.firstElementChild?.querySelector('span.truncate')?.textContent === ${JSON.stringify(title)})?.querySelector('.overflow-y-auto')`;

  await load();
  await sleep(1500);
  await shot('command-center.png');
  check('opens the 1,000-message chat at its newest message', await open(2) && await open(1) && await open(0));
  await sleep(600);
  await shot('chat-bottom.png');

  // Drafts: type, switch away and back, then reload.
  await click('textarea');
  await cdp.send('Input.insertText', { text: 'a draft that should survive' });
  await sleep(300);
  await click('div[role="button"]', chatTitle(1));
  await sleep(400);
  await click('div[role="button"]', chatTitle(0));
  await sleep(400);
  check('draft survives switching away and back', (await cdp.evaluate(`${composer(chatTitle(0))}?.value`)) === 'a draft that should survive');
  check('switching back puts the caret in the composer', await cdp.evaluate(`document.activeElement === ${composer(chatTitle(0))}`));
  await sleep(600); // past the draft debounce
  await load();
  await open(1);
  await open(0);
  check('draft survives a reload', (await cdp.evaluate(`${composer(chatTitle(0))}?.value`)) === 'a draft that should survive');

  // Stream a reply and follow it.
  await cdp.evaluate(`(() => { const t = ${composer(chatTitle(0))}; t.focus(); t.select(); })()`);
  await cdp.send('Input.insertText', { text: `${STREAM_TRIGGER} go` });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  for (let i = 0; i < 200 && mock.state.streamsStarted === 0; i++) await sleep(50);
  await sleep(2000);
  const gap = await cdp.evaluate(`(() => { const s = ${scroller(chatTitle(0))}; return s.scrollHeight - s.scrollTop - s.clientHeight; })()`);
  check('follows the bottom while the reply streams', gap < 80, `${Math.round(gap)} px from the bottom`);
  await shot('streaming.png');
  await sleep(1000);

  // Scroll up mid-stream: it must stay put, and offer the jump pill.
  const box = await cdp.evaluate(`(() => { const r = ${scroller(chatTitle(0))}.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -1500 });
  await sleep(300);
  const before = await cdp.evaluate(`${scroller(chatTitle(0))}.scrollTop`);
  await sleep(1500);
  const after = await cdp.evaluate(`${scroller(chatTitle(0))}.scrollTop`);
  check('scrolling up mid-stream is not yanked back down', Math.abs(after - before) < 2, `moved ${Math.round(after - before)} px`);
  const pill = await cdp.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Jump to latest'))`);
  check('offers the jump pill while scrolled up', pill);
  await shot('scrolled-up.png');
  if (pill) {
    await click('button', '↓ Jump to latest');
    await sleep(1500);
    const g = await cdp.evaluate(`(() => { const s = ${scroller(chatTitle(0))}; return s.scrollHeight - s.scrollTop - s.clientHeight; })()`);
    check('jump pill goes back to following', g < 80, `${Math.round(g)} px from the bottom`);
  }

  // Away and back mid-reply: the reply keeps going on screen.
  const liveLen = () => cdp.evaluate(`(() => { const a = [...${scroller(chatTitle(0))}.querySelectorAll('.msg-ai')].pop(); return a ? a.textContent.length : 0; })()`);
  const l0 = await liveLen();
  await click('div[role="button"]', chatTitle(1));
  await sleep(1200);
  await click('div[role="button"]', chatTitle(0));
  await sleep(300);
  const l1 = await liveLen();
  await sleep(800);
  const l2 = await liveLen();
  check('a reply streaming in the background is caught up when shown', l1 > l0 && l2 > l1, `${l0} -> ${l1} -> ${l2} chars`);

  // The end of the reply: it lands once, as a stored message.
  for (let i = 0; i < 80 && mock.state.streamsFinished === 0; i++) await sleep(250);
  await sleep(1500);
  const tail = await cdp.evaluate(`(() => {
    const s = ${scroller(chatTitle(0))};
    const replies = [...s.querySelectorAll('.msg-ai')].map((a) => a.textContent.slice(0, 40));
    return { replies: replies.slice(-3), dupes: replies.length - new Set(replies).size };
  })()`);
  check('the finished reply is shown once', tail.dupes === 0, JSON.stringify(tail.replies));
  await shot('finished.png');
} catch (e) {
  check(`run completed (${e.message})`, false);
} finally {
  cleanup();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed; screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
