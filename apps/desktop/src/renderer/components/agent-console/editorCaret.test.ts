import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealEditorCaret } from './editorCaret.js';

afterEach(() => vi.unstubAllGlobals());
describe('revealEditorCaret', () => {
  it.each([[180, 200, 112], [0, 20, -12]])('scrolls only the editor to expose the caret', (top, bottom, expected) => {
    const el = { scrollTop: 0, contains: () => true, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
    vi.stubGlobal('document', { activeElement: el });
    vi.stubGlobal('window', { getSelection: () => ({ rangeCount: 1, focusNode: {}, getRangeAt: () => ({ cloneRange: () => ({ collapse: () => {}, getBoundingClientRect: () => ({ top, bottom, height: 20 }) }) }) }) });
    revealEditorCaret(el as unknown as HTMLElement);
    expect(el.scrollTop).toBe(expected);
  });
  it('does not scroll an unfocused editor', () => {
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('window', { getSelection: () => null });
    const el = { scrollTop: 10 };
    revealEditorCaret(el as HTMLElement);
    expect(el.scrollTop).toBe(10);
  });
});
