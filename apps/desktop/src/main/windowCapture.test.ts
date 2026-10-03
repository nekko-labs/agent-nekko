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
  it('validates recording duration before creating a recorder', async () => {
    await captureWindow('record', { action: 'list' });
    await expect(captureWindow('record', { action: 'record', window_id: source.id, seconds: 30 })).rejects.toThrow('1–15');
  });
});
