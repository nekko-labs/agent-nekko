import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastReplyInterrupted } from '../../shared/src/chat.js';
import { setDataDir } from './paths.js';
import { createSession, getSession, saveSession } from './sessions.js';
import { reconcileInterruptedChats } from './chat.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-reconcile-'));
  setDataDir(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('reconcileInterruptedChats', () => {
  it('marks a chat the previous host left mid-turn, and offers it for resuming', () => {
    const s = createSession();
    s.messages = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'npm ci' } }], createdAt: 2 },
    ];
    s.activeRun = { startedAt: 2 };
    saveSession(s);

    expect(reconcileInterruptedChats()).toBe(1);
    const after = getSession(s.id)!;
    expect(after.activeRun).toBeUndefined();
    expect(after.messages.at(-1)).toMatchObject({ role: 'assistant', interrupted: true });
    expect(after.messages.at(-1)!.content).toMatch(/closed while this reply was running/);
    expect(lastReplyInterrupted(after.messages)).toBe(true);
    // Running again finds nothing to do.
    expect(reconcileInterruptedChats()).toBe(0);
  });

  it('leaves finished chats alone and does not double-mark an already interrupted reply', () => {
    const done = createSession();
    done.messages = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'Done.', createdAt: 2 },
    ];
    saveSession(done);
    const marked = createSession();
    marked.messages = [
      { id: 'u1', role: 'user', content: 'go', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'cut', interrupted: true, createdAt: 2 },
    ];
    marked.activeRun = { startedAt: 2 };
    saveSession(marked);

    expect(reconcileInterruptedChats()).toBe(1);
    expect(getSession(done.id)!.messages).toHaveLength(2);
    expect(getSession(marked.id)!.messages).toHaveLength(2);
    expect(getSession(marked.id)!.activeRun).toBeUndefined();
  });
});

describe('lastReplyInterrupted', () => {
  it('does not call completed tool work interrupted', () => {
    expect(lastReplyInterrupted([
      { id: 'u', role: 'user', content: 'go', createdAt: 0 },
      { id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', input: {} }], createdAt: 1 },
      { id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c', output: 'done' }, createdAt: 2 },
      { id: 'final', role: 'assistant', content: 'Next step is implementation.', createdAt: 3 },
    ])).toBe(false);
  });
  it('detects unresolved calls even after another call returned', () => {
    expect(lastReplyInterrupted([
      { id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'bash', input: {} }, { id: 'c2', name: 'read_file', input: {} }], createdAt: 0 },
      { id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c1', output: 'done' }, createdAt: 1 },
    ])).toBe(true);
  });
  it('does not retain an old interruption after a successful continuation', () => {
    expect(lastReplyInterrupted([
      { id: 'a', role: 'assistant', content: 'partial', interrupted: true, createdAt: 0 },
      { id: 'done', role: 'assistant', content: 'Finished.', createdAt: 1 },
    ])).toBe(false);
  });
  it('reads an interruption off the transcript', () => {
    expect(lastReplyInterrupted([])).toBe(false);
    expect(lastReplyInterrupted([{ id: 'u', role: 'user', content: 'x', createdAt: 0 }])).toBe(false);
    expect(lastReplyInterrupted([{ id: 'a', role: 'assistant', content: 'ok', createdAt: 0 }])).toBe(false);
    expect(lastReplyInterrupted([{ id: 'a', role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'bash', input: {} }], createdAt: 0 }])).toBe(true);
    expect(lastReplyInterrupted([{ id: 'a', role: 'assistant', content: 'cut', interrupted: true, createdAt: 0 }])).toBe(true);
    expect(lastReplyInterrupted([{ id: 't', role: 'tool', content: '', toolResult: { toolCallId: 'c', output: '' }, createdAt: 0 }])).toBe(false);
  });
});
