import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ sources: vi.fn() }));
vi.mock('electron', () => ({ desktopCapturer: { getSources: fake.sources }, BrowserWindow: class {} }));
import { captureWindow } from './windowCapture.js';
const source = { id: 'window:123:0', name: 'Actual app', thumbnail: { isEmpty: () => false, getSize: () => ({ width: 1000, height: 700 }), toPNG: () => Buffer.from('png') } };
beforeEach(() => { fake.sources.mockReset(); fake.sources.mockResolvedValue([source]); });
describe('actual desktop window capture', () => {
  it('lists only windows, without revealing thumbnails', async () => {
    expect(await captureWindow('a', { action: 'list' })).toEqual({ windows: [{ id: source.id, title: source.name }] });
    expect(fake.sources).toHaveBeenCalledWith(expect.objectContaining({ types: ['window'], thumbnailSize: { width: 0, height: 0 } }));
  });
  it('scopes selection to a chat and captures the selected actual window', async () => {
    await captureWindow('owner', { action: 'list' });
    await expect(captureWindow('other', { action: 'screenshot', window_id: source.id })).rejects.toThrow('List windows first');
    expect(await captureWindow('owner', { action: 'screenshot', window_id: source.id })).toMatchObject({ title: 'Actual app', width: 1000, height: 700, mime: 'image/png', data: Buffer.from('png').toString('base64') });
  });
  it('does not substitute another window when the source disappears', async () => {
    await captureWindow('gone', { action: 'list' });
    fake.sources.mockResolvedValue([]);
    await expect(captureWindow('gone', { action: 'screenshot', window_id: source.id })).rejects.toThrow('disappeared');
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
    fake.sources.mockResolvedValue([{ ...source, thumbnail: { isEmpty: () => true } }]);
    await expect(captureWindow('empty', { action: 'screenshot', window_id: source.id })).rejects.toThrow('no window was restored or focused');
  });
  it('validates recording duration before creating a recorder', async () => {
    await captureWindow('record', { action: 'list' });
    await expect(captureWindow('record', { action: 'record', window_id: source.id, seconds: 30 })).rejects.toThrow('1–15');
  });
});
