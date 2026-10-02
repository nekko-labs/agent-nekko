/**
 * Minimal CDP driver for capturing the web edition's UI.
 *
 * Usage:
 *   node scripts/cdp-shot.mjs screenshot <out.png>
 *   node scripts/cdp-shot.mjs eval "<js expression>"
 *   node scripts/cdp-shot.mjs click <x> <y>
 *   node scripts/cdp-shot.mjs mousemove <x> <y>
 *   node scripts/cdp-shot.mjs mousedown <x> <y> / mouseup <x> <y>
 *   node scripts/cdp-shot.mjs type "<text>"
 *   node scripts/cdp-shot.mjs navigate <url>
 *   node scripts/cdp-shot.mjs list-targets
 *
 * Expects a browser with --remote-debugging-port=9222 already open on the page.
 * Dev-tool convenience only; not part of the shipped app.
 */
import { writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const HTTP = 'http://127.0.0.1:9222';

async function target() {
  const res = await fetch(`${HTTP}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
  if (!page) throw new Error(`no page target; targets: ${list.map((t) => `${t.type}:${t.url}`).join(', ')}`);
  return page;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : r(msg.result);
      }
    });
    ws.send2 = (method, params = {}) =>
      new Promise((r, rej) => {
        const mid = ++id;
        pending.set(mid, { resolve: r, reject: rej });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    ws.on('close', () => {
      for (const { reject: rej } of pending.values()) rej(new Error('ws closed'));
    });
  });
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  const page = await target();
  const ws = await connect(page.webSocketDebuggerUrl);
  const send = ws.send2;
  await send('Page.enable');
  await send('Runtime.enable');

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  const shot = async (out) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(r.data, 'base64'));
    console.log(`saved ${out}`);
  };
  const mouse = async (type, x, y, extra = {}) => {
    await send('Input.dispatchMouseEvent', { type, x: Number(x), y: Number(y), button: 'left', ...extra });
  };

  switch (cmd) {
    case 'screenshot':
      await shot(args[0] ?? 'shot.png');
      break;
    case 'eval':
      console.log(JSON.stringify(await evalJs(args[0]), null, 1));
      break;
    case 'navigate':
      await send('Page.navigate', { url: args[0] });
      break;
    case 'list-targets':
      console.log(JSON.stringify(await (await fetch(`${HTTP}/json`)).json(), null, 1));
      break;
    case 'click':
      await mouse('mousePressed', args[0], args[1], { clickCount: 1 });
      await mouse('mouseReleased', args[0], args[1], { clickCount: 1 });
      break;
    case 'dblclick':
      await mouse('mousePressed', args[0], args[1], { clickCount: 2 });
      await mouse('mouseReleased', args[0], args[1], { clickCount: 2 });
      break;
    case 'mousemove':
      await mouse('mouseMoved', args[0], args[1]);
      break;
    case 'mousedown':
      await mouse('mousePressed', args[0], args[1], { clickCount: 1 });
      break;
    case 'mouseup':
      await mouse('mouseReleased', args[0], args[1], { clickCount: 1 });
      break;
    case 'type': {
      for (const ch of args[0]) {
        await send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      }
      break;
    }
    case 'key': {
      // e.g. Enter, Escape, ArrowLeft
      const keyMap = { Enter: 13, Escape: 27, ArrowLeft: 37, ArrowRight: 39, Tab: 9 };
      const code = keyMap[args[0]] ?? args[0].charCodeAt(0);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: args[0], windowsVirtualKeyCode: code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: args[0], windowsVirtualKeyCode: code });
      break;
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
