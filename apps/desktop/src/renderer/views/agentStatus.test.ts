import { describe, expect, it } from 'vitest';
import { mergeAgentStatuses, nextAgentFlag } from './agentStatus.js';

describe('nextAgentFlag', () => {
  it('flags approvals and questions as needing input', () => {
    expect(nextAgentFlag(undefined, 'tool_approval_required')).toBe('input');
    expect(nextAgentFlag(undefined, 'question')).toBe('input');
  });

  it('clears the flag once the turn moves again or ends', () => {
    expect(nextAgentFlag('input', 'tool_result')).toBeUndefined();
    expect(nextAgentFlag('input', 'question_resolved')).toBeUndefined();
    expect(nextAgentFlag('error', 'text')).toBeUndefined();
    expect(nextAgentFlag('input', 'done')).toBeUndefined();
  });

  it('leaves the flag alone for bookkeeping that lands after done', () => {
    expect(nextAgentFlag(undefined, 'session_meta')).toBeUndefined();
    expect(nextAgentFlag('error', 'session_meta')).toBe('error');
    expect(nextAgentFlag('input', 'compaction')).toBe('input');
  });
});

describe('mergeAgentStatuses', () => {
  it('shows running sessions as working unless a flag says more', () => {
    const m = mergeAgentStatuses(new Map([['b', 'input'], ['c', 'error']]), ['a', 'b']);
    expect(Object.fromEntries(m)).toEqual({ a: 'working', b: 'input', c: 'error' });
  });

  it('shows nothing for an idle, unflagged session', () => {
    expect(mergeAgentStatuses(new Map(), []).size).toBe(0);
  });
});
