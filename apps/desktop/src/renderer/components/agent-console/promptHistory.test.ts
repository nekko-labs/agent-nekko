import { describe, expect, it } from 'vitest';
import { promptHistory, recallPrompt } from './promptHistory.js';
import type { Session } from '@nekko-agent/shared';

describe('composer prompt history', () => {
  it('uses user prompts and original skill input, excluding empty image prompts', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'expanded skill', skill: { input: '/review diff' } },
      { role: 'user', content: '' },
    ] as Session['messages'];
    expect(promptHistory(messages)).toEqual(['first', '/review diff']);
  });

  it('walks older and newer prompts, clamps at oldest and clears past newest', () => {
    const history = ['first', 'second'];
    let cursor = recallPrompt(history, null, '', 'ArrowUp', 0, 0)!;
    expect(cursor.text).toBe('second');
    cursor = recallPrompt(history, cursor, cursor.text, 'ArrowUp', 0, 0)!;
    expect(cursor.text).toBe('first');
    cursor = recallPrompt(history, cursor, cursor.text, 'ArrowUp', 0, 0)!;
    expect(cursor.index).toBe(0);
    cursor = recallPrompt(history, cursor, cursor.text, 'ArrowDown', 5, 5)!;
    expect(cursor.text).toBe('second');
    cursor = recallPrompt(history, cursor, cursor.text, 'ArrowDown', 6, 6)!;
    expect(cursor.text).toBe('');
    expect(recallPrompt(history, cursor, '', 'ArrowUp', 0, 0)?.text).toBe('second');
  });

  it('does not capture selections, empty history, or Down on a fresh draft', () => {
    expect(recallPrompt([], null, '', 'ArrowUp', 0, 0)).toBeNull();
    expect(recallPrompt(['one'], null, 'draft', 'ArrowUp', 0, 3)).toBeNull();
    expect(recallPrompt(['one'], null, 'draft', 'ArrowDown', 5, 5)).toBeNull();
    expect(recallPrompt(['one'], { index: 0, text: 'one' }, 'edited', 'ArrowDown', 6, 6)).toBeNull();
  });

  it('preserves multiline caret movement until reaching the boundary', () => {
    const history = ['one', 'two\nthree'];
    const cursor = { index: 1, text: history[1] };
    expect(recallPrompt(history, cursor, cursor.text, 'ArrowUp', 4, 4)).toBeNull();
    expect(recallPrompt(history, cursor, cursor.text, 'ArrowDown', 0, 0)).toBeNull();
    expect(recallPrompt(history, cursor, cursor.text, 'ArrowUp', 0, 0)?.text).toBe('one');
    expect(recallPrompt(history, cursor, cursor.text, 'ArrowDown', 9, 9)?.text).toBe('');
  });
});
