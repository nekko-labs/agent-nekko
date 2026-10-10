import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@nekko-agent/shared';

vi.mock('./store.js', () => ({ useStore: { getState: () => ({}) } }));

const { decideNotification } = await import('./notifications.js');

const ctx = (over: Partial<Parameters<typeof decideNotification>[1]> = {}) => ({
  enabled: true,
  windowHidden: true,
  visibleSessionId: null,
  titleOf: (id: string) => (id === 'a' ? 'Fix the parser' : undefined),
  ...over,
});

const done: AgentEvent = { type: 'done', sessionId: 'a', messageId: 'm' };

describe('decideNotification', () => {
  it('tells about a finished, failed, asking or approval-seeking chat the user is not looking at', () => {
    expect(decideNotification(done, ctx())).toMatchObject({ kind: 'finished', title: 'Reply finished', body: 'Fix the parser' });
    expect(decideNotification({ type: 'error', sessionId: 'a', message: 'anthropic 529: overloaded' }, ctx())).toMatchObject({ kind: 'failed', body: 'Fix the parser: anthropic 529: overloaded' });
    expect(decideNotification({ type: 'question', sessionId: 'a', request: { callId: 'c', askedAt: 0, questions: [{ id: 'q', header: 'Branch', question: 'Which branch?', options: [] }] } }, ctx())).toMatchObject({ kind: 'question', body: 'Fix the parser: Which branch?' });
    expect(decideNotification({ type: 'tool_approval_required', sessionId: 'b', call: { id: 'c', name: 'bash', input: {} }, reason: 'Deletes files', severity: 'high' }, ctx())).toMatchObject({ kind: 'approval', body: 'A chat: Deletes files' });
  });

  it('stays quiet for the chat on screen in a focused window, for Stop, for bookkeeping events, and when switched off', () => {
    expect(decideNotification(done, ctx({ windowHidden: false, visibleSessionId: 'a' }))).toBeNull();
    // Another chat on screen: this one still gets a notice.
    expect(decideNotification(done, ctx({ windowHidden: false, visibleSessionId: 'b' }))).not.toBeNull();
    // The chat is on screen but the window is behind another app: notice.
    expect(decideNotification(done, ctx({ windowHidden: true, visibleSessionId: 'a' }))).not.toBeNull();
    expect(decideNotification({ type: 'error', sessionId: 'a', message: 'Stopped' }, ctx())).toBeNull();
    expect(decideNotification({ type: 'text', sessionId: 'a', delta: 'x' }, ctx())).toBeNull();
    expect(decideNotification({ type: 'tool_result', sessionId: 'a', result: { toolCallId: 'c', output: '' } }, ctx())).toBeNull();
    expect(decideNotification(done, ctx({ enabled: false }))).toBeNull();
    expect(decideNotification({ ...done, relayOnly: true } as unknown as AgentEvent, ctx())).toBeNull();
  });
});
