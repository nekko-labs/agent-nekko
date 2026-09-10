import { describe, it, expect } from 'vitest';
import { extractPrUrls, parsePrUrl, collectSessionPrUrls } from '@agent-nekko/shared';

describe('extractPrUrls', () => {
  it('pulls unique PR URLs out of text and trims trailing punctuation', () => {
    const text = 'Opened https://github.com/nekko-labs/agent-nekko/pull/12 and see (https://github.com/nekko-labs/agent-nekko/pull/12).';
    expect(extractPrUrls(text)).toEqual(['https://github.com/nekko-labs/agent-nekko/pull/12']);
  });

  it('handles multiple distinct PRs', () => {
    const text = 'https://github.com/a/b/pull/1 then https://github.com/c/d/pull/2';
    expect(extractPrUrls(text)).toEqual(['https://github.com/a/b/pull/1', 'https://github.com/c/d/pull/2']);
  });

  it('ignores non-PR github URLs', () => {
    expect(extractPrUrls('https://github.com/a/b/issues/3')).toEqual([]);
    expect(extractPrUrls('')).toEqual([]);
  });
});

describe('parsePrUrl', () => {
  it('parses owner/repo/number', () => {
    expect(parsePrUrl('https://github.com/nekko-labs/agent-nekko/pull/42')).toEqual({
      owner: 'nekko-labs', repo: 'agent-nekko', number: 42,
    });
  });

  it('tolerates a .git suffix on the repo', () => {
    expect(parsePrUrl('https://github.com/o/r.git/pull/7')).toEqual({ owner: 'o', repo: 'r', number: 7 });
  });

  it('returns null for non-PR URLs', () => {
    expect(parsePrUrl('https://example.com')).toBeNull();
  });
});

describe('collectSessionPrUrls', () => {
  it('scans message content and tool output', () => {
    const messages = [
      { content: 'working on it' },
      { content: 'PR up: https://github.com/o/r/pull/5' },
      { content: '', toolResult: { output: 'created https://github.com/o/r/pull/6' } },
      { content: 'dup https://github.com/o/r/pull/5' },
    ];
    expect(collectSessionPrUrls(messages)).toEqual(['https://github.com/o/r/pull/5', 'https://github.com/o/r/pull/6']);
  });
});
