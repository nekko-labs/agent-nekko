import { BrowserWindow, ipcMain, session, type WebContents } from 'electron';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { MAX_PREVIEW_BYTES, PREVIEW_CHANNEL, PREVIEW_POLICY, previewRequestAllowed, validPreviewSource } from '../previewPolicy.js';

/** No engine token, preload, persisted cookies, or host bridge enters this window. */
export function registerArtifactPreview(authorized: (sender: WebContents) => boolean): void {
  const windows = new Map<number, BrowserWindow>();
  const pending = new Set<number>();
  ipcMain.handle(PREVIEW_CHANNEL, async (event, source: unknown) => {
    if (!authorized(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('Preview requires the application main frame.');
    if (!validPreviewSource(source)) throw new Error(`Preview must be HTML under ${MAX_PREVIEW_BYTES} bytes.`);
    const owner = event.sender;
    if (pending.has(owner.id)) throw new Error('A preview is already opening.');
    pending.add(owner.id);
    try {
    // One preview per app window; no accumulation of untrusted renderers.
    windows.get(owner.id)?.close();
    const token = randomUUID();
    const server = createServer((req, res) => {
      if (req.method !== 'GET' || req.url !== `/${token}`) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_POLICY,
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
      res.end(source);
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    if (owner.isDestroyed()) { server.close(); throw new Error('Preview owner closed.'); }
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('Preview transport unavailable.'); }
    const url = `http://127.0.0.1:${address.port}/${token}`;
    const isolated = session.fromPartition(`preview-${token}`);
    isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !previewRequestAllowed(details.url, details.resourceType, url) }));
    const win = new BrowserWindow({ title: 'Nekko · Isolated design preview', width: 1100, height: 800,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    windows.set(owner.id, win);
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    win.webContents.on('will-redirect', (event) => event.preventDefault());
    const close = () => { if (!win.isDestroyed()) win.close(); };
    owner.once('destroyed', close);
    win.once('closed', () => {
      owner.removeListener('destroyed', close);
      if (windows.get(owner.id) === win) windows.delete(owner.id);
      server.close(); server.closeAllConnections();
      void isolated.clearStorageData();
    });
    try { await win.loadURL(url); } catch (error) { close(); throw error; }
    } finally { pending.delete(owner.id); }
  });
}
