import { describe, expect, it } from 'vitest';
import { indentListSelection } from './composerLists.js';

describe('indentListSelection', () => {
  it('indents the bullet the caret is on and keeps the caret in place within it', () => {
    const text = '- one\n- two';
    const r = indentListSelection(text, 9, 9, false)!;
    expect(r.text).toBe('- one\n  - two');
    expect(r.selectionStart).toBe(11);
    expect(r.selectionEnd).toBe(11);
  });

  it('outdents by one level and never past the line start', () => {
    const r = indentListSelection('- one\n    - two', 15, 15, true)!;
    expect(r.text).toBe('- one\n  - two');
    expect(r.selectionStart).toBe(13);
    const flat = indentListSelection('- one', 2, 2, true)!;
    expect(flat.text).toBe('- one');
    expect(flat.selectionStart).toBe(2);
  });

  it('handles numbered lists, tasks and a trailing newline in the selection', () => {
    expect(indentListSelection('1. a\n2) b\n- [ ] c\n', 0, 10, false)!.text).toBe('  1. a\n  2) b\n- [ ] c\n');
    // Selecting up to and including the newline after "b" does not touch "c".
    const r = indentListSelection('- a\n- b\n- c', 0, 8, false)!;
    expect(r.text).toBe('  - a\n  - b\n- c');
    expect([r.selectionStart, r.selectionEnd]).toEqual([2, 12]);
  });

  it('leaves the key alone off a list line', () => {
    expect(indentListSelection('plain text', 3, 3, false)).toBeNull();
    expect(indentListSelection('- a\n\nplain', 5, 5, false)).toBeNull();
  });
});
