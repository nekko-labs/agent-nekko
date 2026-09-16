import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '@agent-nekko/shared';
import type { Host } from '@agent-nekko/host';
import {
  acceptKey,
  apiServerStatus,
  bearerOf,
  closeApiServer,
  encodeTextFrame,
  newApiToken,
  readControlFrames,
  syncApiServer,
  tokenMatches,
} from './api-server.js';

const TOKEN = 'test-token-0123456789';

/** A port unlikely to collide with anything else on the machine running tests. */
function freePort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

/**
 * The slice of the host this server touches: settings to read, and the event
 * bus a socket subscribes to. Everything else is only reached through the
 * dispatcher, which builds its table lazily.
 */
function fakeHost(overrides: Partial<AppSettings> = {}): Host & { settings: AppSettings } {
  const settings = { providers: [], ...overrides } as unknown as AppSettings;
  const host = {
    settings,
    events: new EventEmitter(),
    getSettings: () => settings,
    updateSettings: (patch: Partial<AppSettings>) => Object.assign(settings, patch),
    listSessions: () => [{ id: 's1', title: 'A session' }],
  };
  return host as unknown as Host & { settings: AppSettings };
}

afterEach(() => closeApiServer());

describe('websocket framing', () => {
  it('answers the handshake with RFC 6455\'s own example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('picks the length form the payload needs', () => {
    expect(encodeTextFrame('hi').subarray(0, 2)).toEqual(Buffer.from([0x81, 2]));

    const medium = encodeTextFrame('x'.repeat(300));
    expect(medium[1]).toBe(126);
    expect(medium.readUInt16BE(2)).toBe(300);

    const large = encodeTextFrame('x'.repeat(70000));
    expect(large[1]).toBe(127);
    expect(Number(large.readBigUInt64BE(2))).toBe(70000);
  });

  it('notices a close frame and keeps a partial one for the next chunk', () => {
    // A masked, empty close frame, which is what a client sends on hang-up.
    expect(readControlFrames(Buffer.from([0x88, 0x80, 0, 0, 0, 0])).closed).toBe(true);

    // A masked 4-byte text frame split across two reads.
    const frame = Buffer.from([0x81, 0x84, 1, 2, 3, 4, 9, 9, 9, 9]);
    const first = readControlFrames(frame.subarray(0, 6));
    expect(first.closed).toBe(false);
    expect(first.rest).toHaveLength(6);
    expect(readControlFrames(Buffer.concat([first.rest, frame.subarray(6)])).rest).toHaveLength(0);
  });
});

describe('tokens', () => {
  it('compares tokens without short-circuiting on length alone', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, 'wrong')).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
    expect(tokenMatches(TOKEN, '')).toBe(false);
  });

  it('reads the bearer from the header, or the query a socket has to use', () => {
    const url = new URL('http://127.0.0.1/api/events?token=from-query');
    expect(bearerOf({ headers: { authorization: 'Bearer from-header' } } as never, url)).toBe('from-header');
    expect(bearerOf({ headers: {} } as never, url)).toBe('from-query');
    expect(bearerOf({ headers: {} } as never, new URL('http://127.0.0.1/api/x'))).toBeUndefined();
  });

  it('mints tokens that are url-safe and not guessable by length', () => {
    const a = newApiToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newApiToken()).not.toBe(a);
  });
});

describe('serving', () => {
  const settled = () => new Promise((r) => setTimeout(r, 120));

  it('stays off until it is switched on', async () => {
    const host = fakeHost({ apiServer: { enabled: false, port: freePort(), bind: 'local', token: TOKEN } });
    syncApiServer(host);
    await settled();
    expect(apiServerStatus(host).running).toBe(false);
  });

  it('serves the dispatcher to a caller with the token, and nobody else', async () => {
    const port = freePort();
    const host = fakeHost({ apiServer: { enabled: true, port, bind: 'local', token: TOKEN } });
    syncApiServer(host);
    await settled();

    const status = apiServerStatus(host);
    expect(status.running).toBe(true);
    expect(status.url).toBe(`http://127.0.0.1:${port}`);

    const anonymous = await fetch(`http://127.0.0.1:${port}/api/sessions:list`, { method: 'POST' });
    expect(anonymous.status).toBe(401);

    const wrong = await fetch(`http://127.0.0.1:${port}/api/sessions:list`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${port}/api/sessions:list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual([{ id: 's1', title: 'A session' }]);

    // And the request actually counted, which is what the tab reports.
    expect(apiServerStatus(host).requests).toBe(1);
  });

  it('refuses to listen without a token, and says why', async () => {
    const host = fakeHost({ apiServer: { enabled: true, port: freePort(), bind: 'local', token: '' } });
    syncApiServer(host);
    await settled();

    const status = apiServerStatus(host);
    expect(status.running).toBe(false);
    expect(status.error).toMatch(/token is required/i);
  });

  it('streams agent events to a socket that authenticated', async () => {
    const port = freePort();
    const host = fakeHost({ apiServer: { enabled: true, port, bind: 'local', token: TOKEN } });
    syncApiServer(host);
    await settled();

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events?token=${TOKEN}`);
    const message = new Promise<string>((resolve, reject) => {
      socket.onmessage = (e) => resolve(String(e.data));
      socket.onerror = () => reject(new Error('socket failed'));
    });
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('socket failed'));
    });

    host.events.emit('agentEvent', { sessionId: 's1', type: 'text', delta: 'hi' });
    expect(JSON.parse(await message)).toMatchObject({
      payload: { sessionId: 's1', type: 'text', delta: 'hi' },
    });
    socket.close();
  });

  it('turns a socket away without the token', async () => {
    const port = freePort();
    const host = fakeHost({ apiServer: { enabled: true, port, bind: 'local', token: TOKEN } });
    syncApiServer(host);
    await settled();

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/events`);
    await expect(
      new Promise((resolve, reject) => {
        socket.onopen = () => resolve('opened');
        socket.onerror = () => reject(new Error('refused'));
      }),
    ).rejects.toThrow(/refused/);
  });
});
