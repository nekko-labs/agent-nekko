import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const windows: any[] = [];
  class Window {
    static getAllWindows() { return windows; }
    opts: any;
    handlers = new Map<string, (...args: any[]) => void>();
    webContents = {
      setWindowOpenHandler: vi.fn(), on: vi.fn(),
      executeJavaScript: vi.fn(async () => 'Example\nBody'),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), on: vi.fn() },
    };
    constructor(opts: any) { this.opts = opts; windows.push(this); }
    on(name: string, cb: (...args: any[]) => void) { this.handlers.set(name, cb); }
    destroy() { this.handlers.get('closed')?.(); }
    show = vi.fn();
    loadURL = vi.fn(async () => {});
  }
  return { Window, windows };
});
vi.mock('electron', () => ({ BrowserWindow: fake.Window }));
import { startAgentBrowser } from './agentBrowser.js';

afterEach(() => { fake.windows.length = 0; });

describe('private Electron browser bridge', () => {
  it('rejects unauthenticated and page-origin requests, isolates content, and closes sessions', async () => {
    const bridge = await startAgentBrowser();
    const body = JSON.stringify({ sessionId: 'chat', action: 'navigate', url: 'https://example.com' });
    const post = (headers: Record<string, string>, payload = body) => fetch(bridge.url, { method: 'POST', headers, body: payload });
    try {
      expect((await post({})).status).toBe(403);
      expect((await post({ Authorization: `Bearer ${bridge.token}`, Origin: 'https://evil.test' })).status).toBe(403);
      expect(fake.windows).toHaveLength(0);
      const headers = { Authorization: `Bearer ${bridge.token}` };
      expect((await post(headers, JSON.stringify({ sessionId: 'chat', action: 'navigate', url: 'file:///secret' }))).status).toBe(400);
      const result = await post(headers);
      expect(await result.json()).toEqual({ output: 'Example\nBody' });
      const win = fake.windows[0];
      expect(win.opts.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
      expect(win.opts.webPreferences.partition).not.toContain('persist:');
      expect(win.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
      const callback = vi.fn();
      win.webContents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'camera', callback);
      expect(callback).toHaveBeenCalledWith(false);
      const close = await post(headers, JSON.stringify({ sessionId: 'chat', action: 'close' }));
      expect(await close.json()).toEqual({ output: 'In-app browser closed.' });
    } finally { bridge.close(); }
  });
});
