import { BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { captureWindow } from './windowCapture.js';

/** A hidden browser nobody has touched for this long is closed. Each one is a
 *  full renderer that keeps painting (backgroundThrottling is off), and agents
 *  rarely send `close`, so they used to pile up until the app quit. */
const IDLE_CLOSE_MS = 10 * 60_000;

/** Private tool bridge. Only the backend receives its capability token, never page content. */
export async function startAgentBrowser(): Promise<{ url: string; token: string; close: () => void }> {
  const token = randomBytes(32).toString('hex');
  const windows = new Map<string, BrowserWindow>();
  const lastUsed = new Map<string, number>();
  // Electron never frees a partition's session, so a fresh random partition
  // per window grew without bound. One in-memory partition per chat (salted
  // per launch) keeps chats isolated and is reused when a window reopens.
  const partitionSalt = randomBytes(16).toString('hex');
  const guardedPartitions = new Set<string>();
  const partitionFor = (sessionId: string) => `nekko-browser-${createHash('sha256').update(partitionSalt + sessionId).digest('hex').slice(0, 32)}`;
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, win] of windows) {
      if (win.isDestroyed() || win.isVisible() || now - (lastUsed.get(sessionId) ?? 0) < IDLE_CLOSE_MS) continue;
      win.destroy(); windows.delete(sessionId); lastUsed.delete(sessionId);
    }
  }, 60_000);
  reaper.unref();
  let recorderUrl: string | undefined;
  const recorderPath = `/recorder-${randomBytes(24).toString('hex')}`;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Loopback is a secure context for getDisplayMedia. The random route is
    // only an empty recorder page, never a capability-bearing API endpoint.
    if (req.method === 'GET' && req.url === recorderPath && !req.headers.origin) {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'none'; frame-ancestors 'none'" });
      res.end('<html><body>Window recorder</body></html>'); return;
    }
    if (req.method !== 'POST' || req.url !== '/' || req.headers.authorization !== `Bearer ${token}` || req.headers.origin) {
      reply(403, { error: 'Browser bridge access denied.' }); return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 64_000) throw new Error('Browser request too large.');
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const { sessionId, action, url, selector, value } = input;
      if (input.tool === 'capture') {
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('Invalid capture session');
        reply(200, await captureWindow(sessionId, input, recorderUrl, windows.get(sessionId))); return;
      }
      if (typeof sessionId !== 'string' || !sessionId || !['navigate', 'inspect', 'click', 'fill', 'close'].includes(action)) throw new Error('Invalid browser request.');
      let win = windows.get(sessionId);
      lastUsed.set(sessionId, Date.now());
      if (action === 'close') {
        win?.destroy(); windows.delete(sessionId);
        reply(200, { output: 'In-app browser closed.' }); return;
      }
      if (action === 'navigate' && !/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) pages can be opened.');
      if (['click', 'fill'].includes(action) && (typeof selector !== 'string' || !selector || selector.length > 500)) throw new Error('A CSS selector is required.');
      if (input.visible !== undefined && typeof input.visible !== 'boolean') throw new Error('visible must be a boolean.');
      if (!win) {
        win = new BrowserWindow({
          width: 1100, height: 760, title: 'Nekko Browser',
          show: false, skipTaskbar: true,
          // On Linux, focusable=false changes window-manager stacking behavior.
          ...(process.platform !== 'linux' ? { focusable: false } : {}),
          webPreferences: { partition: partitionFor(sessionId), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: true },
        });
        const owned = win;
        windows.set(sessionId, win);
        win.on('closed', () => { if (windows.get(sessionId) === owned) windows.delete(sessionId); });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
        win.webContents.on('will-redirect', (event, target) => { if (!/^https?:\/\//i.test(target)) event.preventDefault(); });
        win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        win.webContents.session.setPermissionCheckHandler(() => false);
        // The partition outlives a reaped window; listen once, not per reopen.
        const partition = partitionFor(sessionId);
        if (!guardedPartitions.has(partition)) { guardedPartitions.add(partition); win.webContents.session.on('will-download', event => event.preventDefault()); }
      }
      // Visibility is explicit and never activates the window or OS input.
      if (input.visible === true) win.showInactive();
      if (input.visible === false) win.hide();
      if (action === 'navigate') await win.loadURL(url);
      if (action === 'click' || action === 'fill') {
        // JSON encoding keeps user-supplied selectors and values out of executable source.
        await win.webContents.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) throw new Error('Selector not found.');
          if (${JSON.stringify(action)} === 'click') el.click();
          else {
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('Field is not a text input.');
            const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value ?? ''))});
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`);
      }
      const output = action === 'fill' ? 'Field filled.' : await win.webContents.executeJavaScript("document.title + '\\n' + (document.body?.innerText ?? '').slice(0, 6000)");
      reply(200, { output });
    } catch (error) { reply(400, { error: (error as Error).message }); }
  });
  server.requestTimeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser bridge did not start.');
  recorderUrl = `http://127.0.0.1:${address.port}${recorderPath}`;
  return { url: `http://127.0.0.1:${address.port}/`, token, close: () => { clearInterval(reaper); for (const win of windows.values()) win.destroy(); server.close(); } };
}
