/**
 * A minimal Chrome DevTools Protocol client over the `ws` package that is
 * already in the tree. Enough for the perf harness: commands with replies,
 * event listeners, and page evaluation. No Playwright, no Puppeteer.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

export async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id != null) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const on = (method, fn) => {
    let set = listeners.get(method);
    if (!set) listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  };

  /** Evaluate an expression in the page and return its value (promises awaited). */
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page eval failed: ${d.exception?.description ?? d.text}`.slice(0, 800));
    }
    return r.result.value;
  };

  /**
   * Call a page function with arguments passed as values: data never becomes
   * part of the source the page evaluates.
   */
  const call = async (fn, ...args) => {
    const g = await send('Runtime.evaluate', { expression: 'globalThis' });
    const r = await send('Runtime.callFunctionOn', {
      objectId: g.result.objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page call failed: ${d.exception?.description ?? d.text}`.slice(0, 800));
    }
    return r.result.value;
  };

  return { send, on, evaluate, call, close: () => ws.close() };
}
