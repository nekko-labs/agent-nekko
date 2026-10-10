import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { Host } from '@nekko-agent/host';
import { startWire, type Wire } from './wire.js';

const TOKEN = 'wire-test-token-0123456789';

/** Only what the wire touches: the event bus. Channels come from overrides. */
function stubHost() {
  return { events: new EventEmitter() } as unknown as Host;
}

let wire: Wire | null = null;
afterEach(() => {
  wire?.close();
  wire = null;
});

async function start(host = stubHost()) {
  wire = await startWire({
    host,
    token: TOKEN,
    origins: ['null', 'file://'],
    overrides: {
      'echo:args': (args) => ({ args }),
      'fail:now': () => {
        throw new Error('asked to fail');
      },
    },
  });
  return { host, url: `http://127.0.0.1:${wire.port}` };
}

const post = (url: string, channel: string, args: unknown[], token = TOKEN) =>
  fetch(`${url}/api/${channel}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  });

function openSocket(url: string, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}${path}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('socket refused'));
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
  });
}

describe('backend wire', () => {
  it('answers a channel over HTTP and reports errors as { error }', async () => {
    const { url } = await start();
    const ok = await post(url, 'echo:args', [1, 'two']);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ args: [1, 'two'] });
    const bad = await post(url, 'fail:now', []);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'asked to fail' });
  });

  it('refuses a missing or wrong token', async () => {
    const { url } = await start();
    expect((await post(url, 'echo:args', [], 'nope')).status).toBe(401);
    await expect(openSocket(url, '/api/ws?token=nope')).rejects.toThrow();
  });

  it('carries requests, replies and events on one socket', async () => {
    const { url, host } = await start();
    const ws = await openSocket(url, `/api/ws?token=${TOKEN}`);
    const reply = nextMessage(ws);
    ws.send(JSON.stringify({ id: 9, channel: 'echo:args', args: ['a'] }));
    expect(await reply).toEqual({ id: 9, result: { args: ['a'] } });

    const event = nextMessage(ws);
    host.events.emit('agentEvent', { type: 'delta', text: 'hi' });
    expect(await event).toEqual({ channel: 'agent:event', payload: { type: 'delta', text: 'hi' } });

    const failed = nextMessage(ws);
    ws.send(JSON.stringify({ id: 10, channel: 'fail:now', args: [] }));
    expect(await failed).toEqual({ id: 10, error: 'asked to fail' });
    ws.close();
  });

  it('narrows the events socket to one channel on request', async () => {
    const { url, host } = await start();
    const ws = await openSocket(url, `/api/events?only=terminal:event&token=${TOKEN}`);
    const got = nextMessage(ws);
    host.events.emit('agentEvent', { type: 'delta' });
    host.events.emit('terminalEvent', { type: 'exit', terminalId: 'term_1', code: 0 });
    expect(await got).toEqual({ channel: 'terminal:event', payload: { type: 'exit', terminalId: 'term_1', code: 0 } });
    ws.close();
  });

  it('stops forwarding events once a socket closes', async () => {
    const { url, host } = await start();
    const ws = await openSocket(url, `/api/events?token=${TOKEN}`);
    expect(host.events.listenerCount('agentEvent')).toBe(1);
    ws.close();
    for (let i = 0; i < 50 && host.events.listenerCount('agentEvent') > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(host.events.listenerCount('agentEvent')).toBe(0);
  });
});
