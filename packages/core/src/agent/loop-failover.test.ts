import { expect, it } from 'vitest';
import type { ChatMessage } from '@agent-nekko/shared';
import type { Provider, ProviderChunk } from '../providers/types.js';
import { ProviderHttpError } from '../providers/errors.js';
import { runAgent } from './loop.js';

function provider(id: string, chat: Provider['chat']): Provider {
  return { config: { id, kind: 'openai-compat', label: id, baseUrl: 'http://localhost', enabled: true }, chat, listModels: async () => [], test: async () => ({ ok: true, message: '' }) };
}

it('continues at the failed response boundary without replaying completed tools; meters the actual route', async () => {
  let calls = 0;
  let tools = 0;
  const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'go', createdAt: 0 }];
  const home = provider('home', async function* () {
    if (++calls === 1) {
      yield { type: 'usage', inputTokens: 2, outputTokens: 3 };
      yield { type: 'tool_call', call: { id: 'c', name: 'write_file', input: {} } };
      return;
    }
    yield { type: 'text', delta: 'failed partial' };
    yield { type: 'tool_call', call: { id: 'not-run', name: 'write_file', input: {} } };
    throw new ProviderHttpError('overloaded', 529);
  });
  const fallback = provider('fallback', async function* (request) {
    expect(request.model).toBe('next');
    expect(request.messages.some((m) => m.role === 'tool' && m.toolResult?.output === 'saved')).toBe(true);
    yield { type: 'usage', inputTokens: 5, outputTokens: 7 };
    yield { type: 'text', delta: 'finished' };
  });
  const usage: unknown[] = [];
  const events = [];
  for await (const e of runAgent({ sessionId: 's', provider: home, model: 'first', system: '', history, retryBaseDelayMs: 0,
    executeTool: async (call) => { tools++; return { toolCallId: call.id, output: 'saved' }; },
    failover: async () => ({ provider: fallback, model: 'next' }), onUsage: (u) => usage.push(u),
  })) events.push(e);
  expect(calls).toBe(6);
  expect(tools).toBe(1);
  expect(history.filter((m) => m.content.includes('Model switched'))).toHaveLength(1);
  expect(history.some((m) => m.content.includes('failed partial'))).toBe(false);
  expect(history.at(-1)?.content).toBe('finished');
  expect(events.at(-1)).toMatchObject({ type: 'done' });
  expect(usage).toEqual([
    { providerId: 'home', modelId: 'first', inputTokens: 2, outputTokens: 3 },
    { providerId: 'fallback', modelId: 'next', inputTokens: 5, outputTokens: 7 },
  ]);
});

it('bounds replacement to one and does not replace non-transient or aborted calls', async () => {
  for (const mode of ['exhaust', 'auth', 'abort']) {
    let switches = 0;
    const abort = new AbortController();
    const failing = provider('home', async function* (): AsyncGenerator<ProviderChunk> {
      if (mode === 'abort') abort.abort();
      throw new ProviderHttpError(mode, mode === 'auth' ? 401 : 529);
    });
    const fallback = provider('fallback', async function* (): AsyncGenerator<ProviderChunk> { throw new ProviderHttpError('still overloaded', 529); });
    const events = [];
    for await (const e of runAgent({ sessionId: 's', provider: failing, model: 'm', system: '', history: [], executeTool: async () => ({ toolCallId: '', output: '' }), retryBaseDelayMs: 0, signal: abort.signal,
      failover: async () => { switches++; return { provider: fallback, model: 'n' }; },
    })) events.push(e);
    expect(switches).toBe(mode === 'exhaust' ? 1 : 0);
    expect(events.at(-1)?.type).toBe('error');
  }
});
