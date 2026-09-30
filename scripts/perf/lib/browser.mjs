/**
 * Find and launch a headless Chromium (Chrome, Edge or Chromium, whichever the
 * machine has) with the DevTools port open.
 *
 * Frame-rate limiting and vsync are switched off unless `vsync` is asked for.
 * The latency budgets are about how long the app takes to put a change on
 * screen, and a headless
 * 60 Hz vsync would add up to a whole 16.7 ms of waiting for the next tick to
 * every sample: noise from the virtual display, not work the app did. With the
 * limiter off a frame starts as soon as the main thread is free, which is how
 * a 120 Hz (or faster) display would see the same work.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function onPath(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split(/\r?\n/)
      .find(Boolean);
    return out || null;
  } catch {
    return null;
  }
}

export function findBrowser() {
  const override = process.env.PERF_BROWSER;
  if (override) {
    if (!existsSync(override)) throw new Error(`PERF_BROWSER points at ${override}, which does not exist`);
    return override;
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const hit = onPath(cmd);
    if (hit) return hit;
  }
  throw new Error('No Chrome, Edge or Chromium found. Set PERF_BROWSER to a Chromium binary.');
}

export async function launchBrowser({ port, width, height, vsync = false }) {
  const bin = findBrowser();
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${mkdtempSync(join(tmpdir(), 'nekko-perf-browser-'))}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    // A backgrounded headless tab still gets full-rate timers and frames.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    'about:blank',
  ];
  if (!vsync) args.unshift('--disable-frame-rate-limit', '--disable-gpu-vsync');
  // CI containers run as root without the user namespaces the sandbox needs.
  if (process.platform === 'linux') args.unshift('--no-sandbox');
  const proc = spawn(bin, args, { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) {
    proc.kill();
    throw new Error(`${bin} did not expose a page target on port ${port}`);
  }
  let version = '';
  try {
    version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser ?? '';
  } catch {
    /* informational only */
  }
  return { proc, bin, version, wsUrl: page.webSocketDebuggerUrl };
}
