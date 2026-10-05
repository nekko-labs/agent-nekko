import { expect, it } from 'vitest';
import { terminalExcerpt } from './terminalExcerpt.js';
it('keeps two trailing lines and strips ANSI styling', () => {
  expect(terminalExcerpt('old\n\x1b[31mred\x1b[0m\nlast\n')).toBe('red\nlast');
});
it('overwrites carriage-return progress and preserves the remaining suffix', () => {
  expect(terminalExcerpt('Progress 10%\rProgress 90%\nDone')).toBe('Progress 90%\nDone');
  expect(terminalExcerpt('abcdef\rxy')).toBe('xycdef');
});
it('handles backspace, CRLF and empty snapshots', () => {
  expect(terminalExcerpt('abc\bD\r\nnext')).toBe('abD\nnext');
  expect(terminalExcerpt('')).toBe('No output yet');
});
