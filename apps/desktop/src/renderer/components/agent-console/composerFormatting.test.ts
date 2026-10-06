import { describe, expect, it } from 'vitest';
import { formatMarkdown, markdownActive, markdownControls } from './composerFormatting.js';

describe('composer Markdown controls', () => {
  it.each(markdownControls.filter(([action]) => ['bold', 'italic', 'strike', 'code', 'link', 'fence'].includes(action)))('toggles %s and preserves selected content', (action) => {
    const added = formatMarkdown('hello', 0, 5, action);
    expect(markdownActive(added.text, added.start, added.end, action)).toBe(true);
    expect(added.text.slice(added.start, added.end)).toBe('hello');
    expect(formatMarkdown(added.text, added.start, added.end, action)).toEqual({ text: 'hello', start: 0, end: 5 });
  });
  it('recognizes and removes emphasis for a caret or partial selection inside a span', () => {
    expect(markdownActive('**hello**', 4, 5, 'bold')).toBe(true);
    expect(markdownActive('**hello**', 4, 4, 'italic')).toBe(false);
    expect(formatMarkdown('**hello**', 4, 5, 'bold')).toEqual({ text: 'hello', start: 2, end: 3 });
  });
  it('inserts paired marks at an empty caret', () => {
    expect(formatMarkdown('', 0, 0, 'bold')).toEqual({ text: '****', start: 2, end: 2 });
  });
  it('applies block controls across selected lines and toggles them off', () => {
    const edit = formatMarkdown('one\ntwo', 0, 7, 'ordered');
    expect(edit.text).toBe('1. one\n2. two');
    expect(markdownActive(edit.text, edit.start, edit.end, 'ordered')).toBe(true);
    expect(formatMarkdown(edit.text, edit.start, edit.end, 'ordered').text).toBe('one\ntwo');
  });
  it('preserves indentation, replaces block styles, and does not mark mixed lists active', () => {
    expect(formatMarkdown('  - first\n  - second', 0, 20, 'task').text).toBe('  - [ ] first\n  - [ ] second');
    expect(formatMarkdown('## title', 3, 8, 'quote').text).toBe('> title');
    expect(markdownActive('- first\nsecond', 0, 14, 'bullet')).toBe(false);
    expect(markdownActive('- [x] done', 6, 10, 'bullet')).toBe(false);
    expect(markdownActive('- [x] done', 6, 10, 'task')).toBe(true);
  });
  it('does not include the next line when selection ends at its beginning', () => {
    expect(formatMarkdown('one\ntwo', 0, 4, 'heading').text).toBe('## one\ntwo');
  });
});
