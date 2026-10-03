import { describe, expect, it } from 'vitest';
import type { AgentEvent, ChatMessage } from './protocol';
import { applyEvent, fromMessages, idleTurn, mergeLive, nextActivity, toolLabel } from './transcript';

const S = 's1';

describe('fromMessages', () => {
  it('pairs tool results with their calls', () => {
    const msgs: ChatMessage[] = [
      { id: 'u', role: 'user', content: 'list files', createdAt: 1 },
      { id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'list_dir', input: { path: 'src' } }], createdAt: 2 },
      { id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: 'a.ts', isError: false }, createdAt: 3 },
      { id: 'b', role: 'assistant', content: 'One file.', reasoning: 'easy', createdAt: 4 },
    ];
    expect(fromMessages(msgs)).toEqual([
      { kind: 'user', id: 'u', text: 'list files', at: 1, images: undefined },
      { kind: 'tool', id: 'c1', name: 'list_dir', label: 'List src', status: 'ok', output: 'a.ts' },
      { kind: 'assistant', id: 'b', text: 'One file.', reasoning: 'easy', interrupted: undefined },
    ]);
  });
});

describe('applyEvent', () => {
  const run = (events: AgentEvent[]) => events.reduce(applyEvent, idleTurn());

  it('streams text and reasoning into one reply', () => {
    const t = run([
      { type: 'reasoning', sessionId: S, delta: 'hm' },
      { type: 'text', sessionId: S, delta: 'Hel' },
      { type: 'text', sessionId: S, delta: 'lo' },
    ]);
    expect(t.running).toBe(true);
    expect(t.blocks).toEqual([{ kind: 'assistant', id: 'live-0', text: 'Hello', reasoning: 'hm', streaming: true }]);
  });

  it('tracks a tool through approval to its result', () => {
    const call = { id: 'c1', name: 'bash', input: { command: 'rm -rf build' } };
    let t = run([
      { type: 'text', sessionId: S, delta: 'Cleaning.' },
      { type: 'tool_call', sessionId: S, call },
      { type: 'tool_approval_required', sessionId: S, call, reason: 'deletes files', severity: 'high' },
    ]);
    expect(t.approval?.severity).toBe('high');
    expect(t.blocks[0]).toMatchObject({ kind: 'assistant', streaming: false });
    expect(t.blocks[1]).toMatchObject({ kind: 'tool', status: 'waiting', label: 'Run rm -rf build' });
    t = applyEvent(t, { type: 'tool_result', sessionId: S, result: { toolCallId: 'c1', output: 'Call not approved by user.', isError: true } });
    expect(t.approval).toBeUndefined();
    expect(t.blocks[1]).toMatchObject({ status: 'error' });
  });

  it('ends on done, and a user stop is not an error', () => {
    expect(run([{ type: 'text', sessionId: S, delta: 'x' }, { type: 'done', sessionId: S, messageId: 'm' }]).running).toBe(false);
    expect(run([{ type: 'error', sessionId: S, message: 'Stopped' }]).error).toBeUndefined();
    expect(run([{ type: 'error', sessionId: S, message: 'chatgpt 400' }]).error).toBe('chatgpt 400');
  });

  it('shows and clears a question', () => {
    const request = { callId: 'q1', questions: [], askedAt: 1 };
    const t = run([{ type: 'question', sessionId: S, request }]);
    expect(t.question).toBe(request);
    expect(applyEvent(t, { type: 'question_resolved', sessionId: S, callId: 'q1' }).question).toBeUndefined();
  });
});

describe('toolLabel', () => {
  it('names the thing a tool acts on', () => {
    expect(toolLabel({ id: '1', name: 'read_file', input: { path: 'src/a.ts' } })).toBe('Read src/a.ts');
    expect(toolLabel({ id: '1', name: 'mcp_thing', input: {} })).toBe('mcp thing');
    expect(toolLabel({ id: '1', name: 'bash', input: { command: 'x'.repeat(200) } }).length).toBeLessThanOrEqual(85);
  });
});

describe('nextActivity', () => {
  it('marks runs and waits, and clears when the turn ends', () => {
    let a = nextActivity({}, { type: 'text', sessionId: 'x', delta: 'a' });
    expect(a).toEqual({ x: 'running' });
    const same = nextActivity(a, { type: 'text', sessionId: 'x', delta: 'b' });
    expect(same).toBe(a);
    a = nextActivity(a, { type: 'question', sessionId: 'x', request: { callId: 'q', questions: [], askedAt: 0 } });
    expect(a).toEqual({ x: 'needs-you' });
    expect(nextActivity(a, { type: 'done', sessionId: 'x', messageId: 'm' })).toEqual({});
    expect(nextActivity(a, { type: 'usage', sessionId: 'x', inputTokens: 1, outputTokens: 1 })).toBe(a);
  });
});

describe('mergeLive', () => {
  const user = { kind: 'user' as const, id: 'u1', text: 'run it' };
  it('keeps streamed text the host has not saved yet', () => {
    const live = [{ ...user, id: 'pending-1' }, { kind: 'assistant' as const, id: 'live-1', text: 'Sure.', streaming: false }];
    expect(mergeLive([user], live)).toEqual([user, live[1]]);
  });
  it('drops what the saved transcript already has', () => {
    const saved = [user, { kind: 'assistant' as const, id: 'a', text: 'Sure.' }, { kind: 'tool' as const, id: 'c1', name: 'bash', label: 'Run x', status: 'ok' as const }];
    const live = [
      { ...user, id: 'pending-1' },
      { kind: 'assistant' as const, id: 'live-1', text: 'Sure.' },
      { kind: 'tool' as const, id: 'c1', name: 'bash', label: 'Run x', status: 'waiting' as const },
      { kind: 'assistant' as const, id: 'live-3', text: 'Done', streaming: true },
    ];
    expect(mergeLive(saved, live)).toEqual([user, saved[1], live[2], live[3]]);
  });
});

describe('mergeLive across turns', () => {
  it('never dedupes against an earlier turn', () => {
    const saved = [
      { kind: 'user' as const, id: 'u1', text: 'run it' },
      { kind: 'assistant' as const, id: 'a1', text: 'Sure.' },
      { kind: 'tool' as const, id: 'call_1', name: 'bash', label: 'Run x', status: 'ok' as const },
    ];
    const live = [
      { kind: 'user' as const, id: 'pending-2', text: 'again' },
      { kind: 'assistant' as const, id: 'live-1', text: 'Sure.' },
      { kind: 'tool' as const, id: 'call_1', name: 'bash', label: 'Run x', status: 'waiting' as const },
    ];
    expect(mergeLive(saved, live)).toEqual([...saved, ...live]);
  });
});
