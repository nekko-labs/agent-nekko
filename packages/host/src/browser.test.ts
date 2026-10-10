import { afterEach, describe, expect, it, vi } from 'vitest';

// These unit fixtures use synthetic normal-session handles, not persisted user data.
vi.mock('./sessions.js', () => ({ getSession: (id: string) => ({ id, executionMode: 'unified' }) }));
import { DEFAULT_SETTINGS } from '@nekko-agent/shared';
import { executeTool } from './tools.js';

const call = { id: 'browser-1', name: 'browser', input: { mode: 'dedicated', action: 'navigate', url: 'https://example.com' } };
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('in-app browser routing', () => {
  it('never contacts the browser before approval', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const requestApproval = vi.fn(async () => false);
    const result = await executeTool(call, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, mode: 'yolo', requestApproval });
    expect(result.isError).toBe(true);
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes approved dedicated actions to Electron instead of launching a browser', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', 'http://127.0.0.1:12345/');
    vi.stubEnv('NEKKO_BROWSER_TOKEN', 'test-token');
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ output: 'Example page' }) }));
    vi.stubGlobal('fetch', fetch);
    const result = await executeTool(call, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval: async () => true });
    expect(result.output).toBe('Example page');
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:12345/', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      body: JSON.stringify({ ...call.input, sessionId: 'chat-1' }),
    }));
  });

  it('fails clearly without an Electron bridge, with no external fallback', async () => {
    vi.stubEnv('NEKKO_BROWSER_URL', ''); vi.stubEnv('NEKKO_BROWSER_TOKEN', '');
    const result = await executeTool(call, { settings: DEFAULT_SETTINGS, sessionId: 'chat-1', allowBrowserControl: true, requestApproval: async () => true });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Restart the desktop app');
  });
});
