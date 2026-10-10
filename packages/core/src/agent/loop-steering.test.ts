import { describe, expect, it } from 'vitest';
import { runAgent } from './loop.js';
import type { Provider, ProviderChunk } from '../providers/types.js';
import type { ChatMessage } from '@nekko-agent/shared';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { id: `${role}_${content}`, role, content, createdAt: 0 };
}

/** A scripted provider that also records what each call was sent. */
function recordingProvider(rounds: ProviderChunk[][]): Provider & { sent: ChatMessage[][] } {
  let i = 0;
  const p = {
    sent: [] as ChatMessage[][],
    config: { id: 'p', kind: 'openai-compat' as const, label: 'x', baseUrl: 'x', enabled: true },
    listModels: async () => [],
    test: async () => ({ ok: true, message: '' }),
    async *chat(req: { messages: ChatMessage[] }) {
      p.sent.push([...req.messages]);
      for (const c of rounds[i++] ?? [{ type: 'done' }]) yield c;
    },
  };
  return p as unknown as Provider & { sent: ChatMessage[][] };
}

const call = (id: string): ProviderChunk => ({ type: 'tool_call', call: { id, name: 'read_file', input: { path: id } } });

describe('runAgent steering', () => {
  it('folds a message sent mid-run into the transcript at the next tool boundary', async () => {
    const provider = recordingProvider([[call('c1')], [call('c2')], [{ type: 'text', delta: 'done' }]]);
    const history: ChatMessage[] = [msg('user', 'go')];
    const inbox: ChatMessage[] = [];
    const events: string[] = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async (c) => {
        // The user types while the first tool runs.
        if (c.id === 'c1') inbox.push({ id: 'steer_1', role: 'user', content: 'Also check the tests', createdAt: 1 });
        return { toolCallId: c.id, output: 'ok' };
      },
      pullSteering: () => inbox.splice(0),
    })) events.push(e.type);

    // The steering message sits after the first tool's result and before the
    // second model call, which therefore saw it; the first call did not.
    const roles = history.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'assistant']);
    expect(history[3]).toMatchObject({ id: 'steer_1', content: 'Also check the tests' });
    expect(provider.sent[0].some((m) => m.id === 'steer_1')).toBe(false);
    expect(provider.sent[1].some((m) => m.id === 'steer_1')).toBe(true);
    expect(events).toContain('steered');
    expect(events.indexOf('steered')).toBeGreaterThan(events.indexOf('tool_result'));
    expect(events.at(-1)).toBe('done');
  });

  it('never pulls steering before the first call or mid-stream', async () => {
    const provider = recordingProvider([[{ type: 'text', delta: 'short answer' }]]);
    const history: ChatMessage[] = [msg('user', 'go')];
    let pulls = 0;
    for await (const _ of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history,
      executeTool: async (c) => ({ toolCallId: c.id, output: '' }),
      pullSteering: () => { pulls++; return []; },
    })) { /* drain */ }
    // A reply with no tool boundary has nowhere to fold steering in; the host
    // queues whatever is left when the turn ends.
    expect(pulls).toBe(0);
  });
});
