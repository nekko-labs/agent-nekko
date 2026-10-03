import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@agent-nekko/shared';
import { executeTool, type ToolHostOptions } from './tools.js';

describe('window capture tool', () => {
  let root: string;
  let opts: ToolHostOptions;
  const call = (input: Record<string, unknown>) => ({ id: 'capture-1', name: 'capture', input });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekko-capture-'));
    opts = { settings: { ...DEFAULT_SETTINGS, sandboxMode: 'off' }, defaultCwd: root, sessionId: 'chat', allowBrowserControl: true, mode: 'yolo', requestApproval: vi.fn(async () => true) };
    vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('NEKKO_BROWSER_TOKEN', 'private-token');
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
  it('never contacts the bridge before approval, including bypass mode', async () => {
    opts.requestApproval = vi.fn(async () => false);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await executeTool(call({ action: 'list' }), opts);
    expect(result.isError).toBe(true);
    expect(opts.requestApproval).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects non-desktop requests without fallback', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await executeTool(call({ action: 'list' }), { ...opts, allowBrowserControl: false });
    expect(result.output).toContain('local desktop');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('writes approved screenshot bytes without exposing base64 in tool output', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ title: 'Other project', window_id: 'window:1', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64'), width: 1200, height: 800 }) }));
    vi.stubGlobal('fetch', fetch);
    const result = await executeTool(call({ action: 'screenshot', window_id: 'window:1', path: '.shots/after.png' }), opts);
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(root, '.shots/after.png'), 'utf8')).toBe('png-bytes');
    expect(result.output).toContain('Other project');
    expect(result.output).not.toContain('data');
    expect(fetch.mock.calls[0]).toBeDefined();
  });
  it.each([
    { action: 'screenshot', window_id: 'window:1', path: '../escape.png' },
    { action: 'record', window_id: 'window:1', path: 'clip.webm', seconds: 16 },
    { action: 'record', window_id: 'window:1', path: 'clip.png' },
    { action: 'screenshot', path: 'shot.png' },
  ])('rejects invalid output or selection before approval: %j', async (input) => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    expect((await executeTool(call(input), opts)).isError).toBe(true);
    expect(opts.requestApproval).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never overwrites existing evidence', async () => {
    writeFileSync(join(root, 'shot.png'), 'before');
    expect((await executeTool(call({ action: 'screenshot', window_id: 'window:1', path: 'shot.png' }), opts)).isError).toBe(true);
    expect(readFileSync(join(root, 'shot.png'), 'utf8')).toBe('before');
  });
  it('fails clearly if the bridge is unavailable', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', '');
    const result = await executeTool(call({ action: 'list' }), opts);
    expect(result.output).toContain('no browser fallback');
  });
});
