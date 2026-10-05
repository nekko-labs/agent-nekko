import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_PREVIEW_BYTES, PREVIEW_CHANNEL, PREVIEW_POLICY, previewRequestAllowed, validPreviewSource } from '../previewPolicy.js';
const handle = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ ipcMain: { handle }, BrowserWindow: vi.fn(), session: {} }));
import { registerArtifactPreview } from './artifactPreview.js';

describe('isolated preview authorization and policy', () => {
  beforeEach(() => handle.mockReset());
  it('rejects callers outside an application main frame', async () => {
    registerArtifactPreview(() => false);
    expect(handle.mock.calls[0][0]).toBe(PREVIEW_CHANNEL);
    const run = handle.mock.calls[0][1];
    await expect(run({ sender: { mainFrame: {} }, senderFrame: {} }, '<h1>x</h1>')).rejects.toThrow('main frame');
    registerArtifactPreview(() => true);
    await expect(handle.mock.calls[1][1]({ sender: { mainFrame: {} }, senderFrame: {} }, 'x')).rejects.toThrow('main frame');
  });
  it('rejects invalid and oversized input before allocating transport', async () => {
    registerArtifactPreview(() => true);
    const frame = {}; const event = { sender: { mainFrame: frame }, senderFrame: frame };
    for (const source of [null, {}, 'x'.repeat(MAX_PREVIEW_BYTES + 1)]) {
      await expect(handle.mock.calls[0][1](event, source)).rejects.toThrow('under');
    }
    expect(validPreviewSource('€'.repeat(400_000))).toBe(false);
  });
  it('allows only its exact initial document, never resources or redirects', () => {
    const url = 'http://127.0.0.1:1234/token';
    expect(previewRequestAllowed(url, 'mainFrame', url)).toBe(true);
    for (const type of ['subFrame', 'xhr', 'script', 'image', 'other', 'webSocket']) expect(previewRequestAllowed(url, type, url)).toBe(false);
    for (const target of ['https://example.com', 'file:///secret', `${url}?leak=1`, `${url}/next`]) expect(previewRequestAllowed(target, 'mainFrame', url)).toBe(false);
  });
  it('denies network, frames, workers, base URLs and forms in the response policy', () => {
    for (const directive of ['connect', 'frame', 'worker', 'object', 'base-uri', 'form-action']) {
      expect(PREVIEW_POLICY).toContain(`${directive.includes('-') ? directive : directive + '-src'} 'none'`);
    }
    expect(PREVIEW_POLICY).toContain("script-src 'unsafe-inline'");
    expect(PREVIEW_POLICY).not.toContain('unsafe-eval');
  });
});
