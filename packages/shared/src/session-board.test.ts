import { describe, expect, it } from 'vitest';
import type { ChatMessage, PendingInput } from './chat.js';
import { isStalled, sessionLane, waitingSince } from './session-board.js';

const msg = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id: `m_${role}_${content.slice(0, 4)}`,
  role,
  content,
  createdAt: 0,
  ...extra,
});

const question: PendingInput = {
  sessionId: 's1',
  question: {
    callId: 'c1',
    askedAt: 1_000,
    questions: [{ id: 'q1', header: 'Scope', question: 'How far?', options: [{ label: 'a' }, { label: 'b' }] }],
  },
};

const approval: PendingInput = {
  sessionId: 's1',
  approval: {
    call: { id: 'c2', name: 'bash', input: { command: 'rm -rf build' } },
    reason: 'Destructive command',
    severity: 'high',
    requestedAt: 2_000,
  },
};

describe('sessionLane', () => {
  const done = [msg('user', 'go'), msg('assistant', 'done')];

  it('puts a chat that is waiting on you first, even while its turn is live', () => {
    // The turn *is* still running when the agent asks — it is parked inside a
    // tool call. Reading that as "working" would hide the one card the board
    // exists to surface.
    expect(sessionLane({ running: true, pending: question, messages: done })).toEqual({
      lane: 'needs-you',
      blocked: 'question',
    });
    expect(sessionLane({ running: true, pending: approval, messages: done })).toEqual({
      lane: 'needs-you',
      blocked: 'approval',
    });
  });

  it('is working when it is running and nothing is blocked', () => {
    expect(sessionLane({ running: true, messages: done })).toEqual({ lane: 'working' });
  });

  it('is idle when the last reply finished', () => {
    expect(sessionLane({ running: false, messages: done })).toEqual({ lane: 'idle' });
    expect(sessionLane({ running: false, messages: [] })).toEqual({ lane: 'idle' });
  });

  it('surfaces a reply that was cut off as something to deal with', () => {
    const cut = [msg('user', 'go'), msg('assistant', 'I was half way through', { interrupted: true })];
    expect(sessionLane({ running: false, messages: cut })).toEqual({ lane: 'needs-you', blocked: 'interrupted' });
  });

  it('does not call a chat stalled once it is running again', () => {
    const cut = [msg('user', 'go'), msg('assistant', 'half', { interrupted: true })];
    expect(sessionLane({ running: true, messages: cut })).toEqual({ lane: 'working' });
  });

  it('only reads the last message as the stall', () => {
    // An interruption the user already carried on from is history, not a state.
    const recovered = [
      msg('user', 'go'),
      msg('assistant', 'half', { interrupted: true }),
      msg('user', 'carry on'),
      msg('assistant', 'finished'),
    ];
    expect(isStalled(recovered)).toBe(false);
    expect(sessionLane({ running: false, messages: recovered })).toEqual({ lane: 'idle' });
  });
});

describe('waitingSince', () => {
  it('reports when the wait started, so the longest wait sorts first', () => {
    expect(waitingSince(question)).toBe(1_000);
    expect(waitingSince(approval)).toBe(2_000);
    expect(waitingSince(undefined)).toBe(0);
    expect(waitingSince({ sessionId: 's' })).toBe(0);
  });
});
