import { describe, expect, it } from 'vitest';
import { terminalExcerpt } from './terminalExcerpt.js';
describe('terminal text preview', () => {
  it('keeps the last two complete lines across CRLF output', () => {
    expect(terminalExcerpt('first\r\nsecond\r\nthird\r\n')).toBe('second\nthird');
  });
  it('keeps the latest carriage-return progress update without concatenating it', () => {
    expect(terminalExcerpt('Preparing\nLoading 10%\rLoading 100%')).toBe('Preparing\nLoading 100%');
  });
  it('strips color and terminal title escapes and handles backspace', () => {
    expect(terminalExcerpt('\x1b]0;private title\x07\x1b[32mready\x1b[0m\nerrorx\b')).toBe('ready\nerror');
  });
  it('labels empty output', () => expect(terminalExcerpt('')).toBe('No output yet'));
});
