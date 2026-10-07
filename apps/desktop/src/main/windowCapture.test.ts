import { runInNewContext } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ sources: vi.fn(), execute: vi.fn(), grant: vi.fn(), destroy: vi.fn(), options: vi.fn() }));
vi.mock('electron', () => ({ desktopCapturer: { getSources: fake.sources }, BrowserWindow: class {
  constructor(options: unknown) { fake.options(options); }
  webContents = { session: { setDisplayMediaRequestHandler: fake.grant }, executeJavaScript: fake.execute, loadURL: vi.fn() };
  loadURL = vi.fn(); isDestroyed = () => false; destroy = fake.destroy;
} }));
import { captureWindow } from './windowCapture.js';
const source = { id: 'window:123:0', name: 'Actual app', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 1000, height: 700 }), toPNG: () => Buffer.from('png') } };
beforeEach(() => { fake.sources.mockReset(); fake.sources.mockResolvedValue([source]); fake.execute.mockReset(); fake.execute.mockResolvedValue({ width: 1000, height: 700, data: Buffer.from('png').toString('base64') }); fake.grant.mockClear(); fake.destroy.mockClear(); fake.options.mockClear(); });
describe('actual desktop window capture', () => {
  it('lists only windows, without revealing thumbnails', async () => {
    expect(await captureWindow('a', { action: 'list' })).toEqual({ windows: [{ id: source.id, title: source.name }] });
    expect(fake.sources).toHaveBeenCalledWith(expect.objectContaining({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }));
  });
  it('scopes selection to a chat and captures the selected actual window', async () => {
    await captureWindow('owner', { action: 'list' });
    await expect(captureWindow('other', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).rejects.toThrow('List windows first');
    expect(await captureWindow('owner', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).toMatchObject({ title: 'Actual app', width: 1000, height: 700, mime: 'image/png', data: Buffer.from('png').toString('base64') });
  });
  it('does not substitute another window when the source disappears', async () => {
    await captureWindow('gone', { action: 'list' });
    fake.sources.mockResolvedValue([]);
    await expect(captureWindow('gone', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).rejects.toThrow('disappeared');
  });
  it('captures only this chat owned hidden page without showing or focusing it', async () => {
    const owned = { id: 7, isDestroyed: () => false, capturePage: vi.fn(async () => source.thumbnail), show: vi.fn(), focus: vi.fn() };
    const win = owned as unknown as import('electron').BrowserWindow;
    const list = await captureWindow('hidden', { action: 'list' }, undefined, win);
    expect(list).toMatchObject({ windows: expect.arrayContaining([{ id: 'nekko:7', title: 'Nekko Browser (owned by this chat)' }]) });
    const shot = await captureWindow('hidden', { action: 'screenshot', window_id: 'nekko:7' }, undefined, win);
    expect(shot).toMatchObject({ source: 'owned-page', background: true });
    expect(owned.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true, stayAwake: false });
    expect(owned.show).not.toHaveBeenCalled();
    expect(owned.focus).not.toHaveBeenCalled();
    await expect(captureWindow('different', { action: 'screenshot', window_id: 'nekko:7' }, undefined, win)).rejects.toThrow('List windows first');
    await expect(captureWindow('hidden', { action: 'screenshot', window_id: 'nekko:7' })).rejects.toThrow('disappeared');
    await expect(captureWindow('hidden', { action: 'record', window_id: 'nekko:7' }, undefined, win)).rejects.toThrow('PNG screenshots only');
  });
  it('reports unavailable native frames without restoring the target', async () => {
    await captureWindow('empty', { action: 'list' });
    fake.execute.mockRejectedValueOnce(new Error('Selected window unavailable; no window was restored or focused'));
    await expect(captureWindow('empty', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).rejects.toThrow('no window was restored or focused');
  });
  it('enumerates without capturing unrelated windows and grants only the selected source', async () => {
    await captureWindow('selected', { action: 'list' });
    fake.sources.mockResolvedValue([source, { ...source, id: 'window:999:0', name: 'Protected app' }]);
    await captureWindow('selected', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234');
    expect(fake.sources.mock.calls.every(([options]) => options.thumbnailSize.width === 0 && options.thumbnailSize.height === 0)).toBe(true);
    const callback = vi.fn(); fake.grant.mock.calls[0][0]({}, callback);
    expect(callback).toHaveBeenCalledWith({ video: source });
    expect(fake.options).toHaveBeenCalledWith(expect.objectContaining({ show: false, focusable: false, skipTaskbar: true }));
    expect(fake.grant).toHaveBeenLastCalledWith(null);
    expect(fake.destroy).toHaveBeenCalledOnce();
  });
  it('releases the capture lock and destroys the helper after a failed acquisition', async () => {
    await captureWindow('retry', { action: 'list' });
    fake.execute.mockRejectedValueOnce(new Error('capture denied'));
    await expect(captureWindow('retry', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).rejects.toThrow('capture denied');
    await expect(captureWindow('retry', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).resolves.toMatchObject({ mime: 'image/png' });
    expect(fake.destroy).toHaveBeenCalledTimes(2);
  });
  it('validates recording duration before creating a recorder', async () => {
    await captureWindow('record', { action: 'list' });
    await expect(captureWindow('record', { action: 'record', window_id: source.id, seconds: 30 })).rejects.toThrow('1–15');
  });
});

 describe('native frame stream cleanup', () => {
  function fixture(frame = true) {
    const stop = vi.fn(); const track = { stop }; const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
    const video = { videoWidth: 640, videoHeight: 480, srcObject: null, pause: vi.fn(), play: async () => {}, requestVideoFrameCallback: (callback: () => void) => { if (frame) queueMicrotask(callback); } };
    const drawImage = vi.fn(); const canvas = { getContext: () => ({ drawImage }), toDataURL: () => 'data:image/png;base64,cG5n' };
    const acquire = vi.fn(async () => stream);
    fake.execute.mockImplementation(code => runInNewContext(code, { navigator: { mediaDevices: { getDisplayMedia: acquire } }, document: { createElement: (tag: string) => tag === 'video' ? video : canvas }, setTimeout, clearTimeout }));
    return { stop, video, acquire, drawImage, stream };
  }
  it('encodes the first frame and stops every stream track', async () => {
    const f = fixture(); await captureWindow('frame', { action: 'list' });
    await expect(captureWindow('frame', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).resolves.toMatchObject({ width: 640, height: 480, data: 'cG5n', mime: 'image/png' });
    expect(f.drawImage).toHaveBeenCalledWith(f.video, 0, 0); expect(f.stop).toHaveBeenCalledOnce(); expect(f.video.srcObject).toBeNull();
    expect(f.acquire).toHaveBeenCalledWith({ video: { frameRate: 15 }, audio: false });
  });
  it('bounds a missing first frame and stops the stream', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(false); await captureWindow('no-frame', { action: 'list' });
      const check = expect(captureWindow('no-frame', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).rejects.toThrow('did not produce a frame');
      await vi.advanceTimersByTimeAsync(5000); await check;
      expect(f.stop).toHaveBeenCalledOnce(); expect(fake.destroy).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('stops an acquisition that resolves after its deadline', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); let finish!: (stream: unknown) => void;
      f.acquire.mockImplementation(() => new Promise(resolve => { finish = resolve; }) as never);
      await captureWindow('late', { action: 'list' });
      const check = expect(captureWindow('late', { action: 'screenshot', window_id: source.id }, 'http://127.0.0.1:1234')).rejects.toThrow('did not start');
      await vi.advanceTimersByTimeAsync(5000); await check;
      finish(f.stream); await Promise.resolve(); await Promise.resolve(); expect(f.stop).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
 });
