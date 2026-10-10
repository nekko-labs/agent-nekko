import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AgentCdpTransport, pageCommandDenial, type AgentTarget } from './agentCdpTransport.js';

class FakeDebugger extends EventEmitter {
  attached = false;
  sent: Array<{ method: string; params?: object; sessionId?: string }> = [];
  constructor(private readonly targetId: string) { super(); }
  attach() { this.attached = true; }
  detach() { this.attached = false; this.emit('detach', {}, 'target closed'); }
  isAttached() { return this.attached; }
  async sendCommand(method: string, params?: object, sessionId?: string) {
    this.sent.push({ method, params, sessionId });
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: this.targetId, type: 'page', title: 'Page', url: 'about:blank', attached: true } };
    return { echoed: method };
  }
}

const target = (id: string): AgentTarget & { webContents: { debugger: FakeDebugger } } => ({
  webContents: { debugger: new FakeDebugger(id), isDestroyed: () => false },
});

function harness(host: Partial<ConstructorParameters<typeof AgentCdpTransport>[0]> = {}) {
  const transport = new AgentCdpTransport({ product: 'Chrome/140.0', userAgent: 'Mozilla/5.0 Nekko', createTarget: async () => { throw new Error('no'); }, closeTarget: vi.fn(), ...host });
  const messages: any[] = [];
  transport.onmessage = (m) => messages.push(m);
  let id = 0;
  const send = async (method: string, params?: object, sessionId?: string) => {
    const messageId = ++id;
    transport.send({ id: messageId, method, params, ...(sessionId ? { sessionId } : {}) });
    await vi.waitFor(() => expect(messages.some((m) => m.id === messageId)).toBe(true));
    return messages.find((m) => m.id === messageId);
  };
  return { transport, messages, send };
}

describe('in-process agent CDP transport', () => {
  it('presents only the windows handed to it, attached through their own debugger', async () => {
    const { transport, messages, send } = harness();
    const page = target('T1');
    await transport.add(page);
    expect(page.webContents.debugger.attached).toBe(false); // nothing attaches before Playwright listens
    expect((await send('Browser.getVersion')).result).toMatchObject({ product: 'Chrome/140.0', userAgent: 'Mozilla/5.0 Nekko' });
    const reply = await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const attachedAt = messages.findIndex((m) => m.method === 'Target.attachedToTarget');
    expect(attachedAt).toBeGreaterThanOrEqual(0);
    expect(attachedAt).toBeLessThan(messages.indexOf(reply)); // the page exists before setAutoAttach returns
    const attached = messages[attachedAt].params;
    expect(attached).toMatchObject({ waitingForDebugger: false, targetInfo: { targetId: 'T1', type: 'page' } });
    expect(page.webContents.debugger.attached).toBe(true);
    expect(transport.targetFor('T1')).toBe(page);
  });

  it('forwards page commands and events, including flattened child sessions', async () => {
    const { transport, messages, send } = harness();
    const page = target('T1');
    await send('Target.setAutoAttach', { autoAttach: true });
    await transport.add(page);
    const sessionId = messages.find((m) => m.method === 'Target.attachedToTarget').params.sessionId;
    expect((await send('Runtime.evaluate', { expression: '1' }, sessionId)).result).toEqual({ echoed: 'Runtime.evaluate' });
    expect(page.webContents.debugger.sent.at(-1)).toEqual({ method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: undefined });
    // A child (iframe/worker) the page attached to is reachable through it.
    page.webContents.debugger.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'CHILD', targetInfo: { targetId: 'F1', type: 'iframe' } }, undefined);
    expect(messages.at(-1)).toMatchObject({ method: 'Target.attachedToTarget', sessionId });
    page.webContents.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log' }, 'CHILD');
    expect(messages.at(-1)).toEqual({ method: 'Runtime.consoleAPICalled', params: { type: 'log' }, sessionId: 'CHILD' });
    await send('DOM.enable', {}, 'CHILD');
    expect(page.webContents.debugger.sent.at(-1)).toEqual({ method: 'DOM.enable', params: {}, sessionId: 'CHILD' });
    expect((await send('Runtime.enable', {}, 'UNKNOWN')).error.message).toContain('No session');
  });

  it('refuses anything that could reach another target, a local file or a download', async () => {
    const { transport, messages, send } = harness();
    const page = target('T1');
    await send('Target.setAutoAttach', { autoAttach: true });
    await transport.add(page);
    const sessionId = messages.find((m) => m.method === 'Target.attachedToTarget').params.sessionId;
    for (const [method, params] of [
      ['Target.attachToTarget', { targetId: 'UI', flatten: true }],
      ['Target.getTargets', {}],
      ['Target.setDiscoverTargets', { discover: true }],
      ['Target.getTargetInfo', { targetId: 'UI' }],
      ['Target.exposeDevToolsProtocol', { targetId: 'T1' }],
      ['Browser.getVersion', {}],
      ['SystemInfo.getInfo', {}],
      ['DOM.setFileInputFiles', { files: ['C:/secret.txt'], nodeId: 1 }],
      ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: 'C:/' }],
      ['Security.setIgnoreCertificateErrors', { ignore: true }],
      ['Page.navigate', { url: 'file:///C:/Windows/win.ini' }],
      ['Page.navigate', { url: 'chrome://settings' }],
    ] as const) {
      const before = page.webContents.debugger.sent.length;
      expect((await send(method, params, sessionId)).error?.message, method).toBeTruthy();
      expect(page.webContents.debugger.sent.length, method).toBe(before); // never reached Chromium
    }
    for (const method of ['Target.getTargets', 'Target.attachToTarget', 'Target.attachToBrowserTarget', 'Target.createBrowserContext', 'Target.setDiscoverTargets', 'Browser.grantPermissions', 'Storage.getCookies']) {
      expect((await send(method, { targetId: 'UI' })).error?.message, method).toContain('not available');
    }
    expect(pageCommandDenial('Page.navigate', { url: 'https://example.com' })).toBeUndefined();
    expect(pageCommandDenial('Page.navigate', { url: 'about:blank' })).toBeUndefined();
    expect(pageCommandDenial('Input.dispatchMouseEvent', {})).toBeUndefined();
    expect(pageCommandDenial('Target.setAutoAttach', {})).toBeUndefined();
  });

  it('accepts the download-behaviour call without lifting the session block', async () => {
    const { send } = harness();
    expect((await send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: '/tmp' })).result).toEqual({});
  });

  it('reports closed windows and detaches every debugger when it closes', async () => {
    const closeTarget = vi.fn();
    const { transport, messages, send } = harness({ closeTarget });
    const one = target('T1');
    const two = target('T2');
    await send('Target.setAutoAttach', { autoAttach: true });
    await transport.add(one);
    await transport.add(two);
    transport.forget(one);
    expect(messages.at(-1)).toMatchObject({ method: 'Target.detachedFromTarget', params: { targetId: 'T1' } });
    expect(one.webContents.debugger.attached).toBe(false);
    expect((await send('Target.closeTarget', { targetId: 'T2' })).result).toEqual({ success: true });
    expect(closeTarget).toHaveBeenCalledWith(two);
    const onclose = vi.fn();
    transport.onclose = onclose;
    transport.close();
    expect(onclose).toHaveBeenCalledOnce();
    expect(two.webContents.debugger.attached).toBe(false);
  });
});
