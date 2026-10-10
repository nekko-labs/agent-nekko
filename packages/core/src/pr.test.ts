import { describe, it, expect } from 'vitest';
import { extractPrUrls, parsePrUrl, collectSessionPrUrls } from '../../shared/src/pr.js';

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
  const url = 'https://github.com/o/r/pull/1';
  const pair = (command: string, isError = false) => [
    { toolCalls: [{ id: 'c', name: 'bash', input: { command } }] },
    { role: 'tool', toolResult: { toolCallId: 'c', output: url, isError } },
  ];
  it('keeps successful CLI and REST creations', () => {
    expect(collectSessionPrUrls(pair('gh pr create --title fix'))).toEqual([url]);
    expect(collectSessionPrUrls(pair('gh api repos/o/r/pulls -X POST --jq .html_url'))).toEqual([url]);
  });
  it('rejects creation text inside source-writing commands and mixed output', () => {
    expect(collectSessionPrUrls(pair('node -e "write test gh pr create"'))).toEqual([]);
    expect(collectSessionPrUrls(pair('powershell -Command "Get-Content fixture with gh pr create"'))).toEqual([]);
    expect(collectSessionPrUrls(pair('gh pr create && cat fixtures'))).toEqual([]);
    const messages = pair('gh pr create');
    messages[1].toolResult!.output = url + '\nhttps://github.com/a.b/c-d/pull/12';
    expect(collectSessionPrUrls(messages)).toEqual([]);
  });
  it('ignores mentions, lookups, edits, reviews, failed calls and unpaired output', () => {
    expect(collectSessionPrUrls([{ role: 'assistant', content: 'Opened ' + url }, { role: 'user', content: url }, { toolResult: { output: url } }])).toEqual([]);
    for (const command of ['gh pr view 1', 'gh pr list', 'gh pr review 1', 'gh api repos/o/r/pulls/1 -X PATCH', 'gh api repos/o/r/pulls']) expect(collectSessionPrUrls(pair(command))).toEqual([]);
    expect(collectSessionPrUrls(pair('gh pr create', true))).toEqual([]);
  });
});
