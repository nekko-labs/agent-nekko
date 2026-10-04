import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, markdownSegments, renderWhole, safeHref } from './Markdown.js';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('renders the reported GitHub PR reply as a labeled link', () => {
    const out = html('Yes—the GitHub integration is in [PR #309](https://github.com/nekko-labs/agent-nekko/pull/309). It’s an open draft with passing checks, not merged or verified against a live GitHub installation.');
    expect(out).toContain('href="https://github.com/nekko-labs/agent-nekko/pull/309"');
    expect(out).not.toContain('[PR #309]');
  });
  it('renders links nested inside emphasis without losing surrounding links', () => {
    const out = html('**[PR #309](https://github.com/nekko-labs/agent-nekko/pull/309)** and *[docs](https://example.com/docs)* then [next](https://example.com/next)');
    expect(out.match(/href=/g)).toHaveLength(3);
    expect(out).not.toContain('[PR #309]');
  });

  it('turns a dashed run glued to a sentence into a real list', () => {
    // The shape people actually type into the composer: a lead-in line with no
    // blank line before the dashes.
    const out = html('Agent Nekko project.\n- first thing\n- second thing');
    expect(out).toContain('<p>Agent Nekko project.</p>');
    expect(out.match(/<li>/g)).toHaveLength(2);
    expect(out).toContain('<li>first thing</li>');
    expect(out).toContain('list-style-type:disc');
  });

  it('nests deeper-indented items under the item above', () => {
    const out = html('- top\n  - child\n  - sibling\n- next top');
    expect(out).toContain('list-style-type:circle');
    // One outer list with two top-level items, one inner list with two.
    expect(out.match(/<ul/g)).toHaveLength(2);
    expect(out.match(/<li>/g)).toHaveLength(4);
  });

  it('keeps single newlines inside a paragraph as line breaks', () => {
    expect(html('one\ntwo')).toContain('one<br/>two');
  });

  it('starts a new list when a numbered run follows a bulleted one', () => {
    const out = html('- bullet\n1. number');
    expect(out).toContain('<ul');
    expect(out).toContain('<ol');
  });

  it('renders numbered lists, headings, quotes and rules', () => {
    expect(html('1. first\n2. second')).toContain('<ol');
    expect(html('## Heading')).toContain('Heading');
    expect(html('> quoted')).toContain('<blockquote');
    expect(html('---')).toContain('<hr');
  });

  it('renders a pipe table with a body', () => {
    const out = html('| Item | Count |\n| --- | --- |\n| Alpha | 1 |');
    expect(out).toContain('<table');
    expect(out).toContain('<th');
    expect(out).toContain('Alpha');
  });

  it('renders fenced code without treating its contents as markdown', () => {
    const out = html('```ts\n- not a bullet\n```');
    expect(out).toContain('<pre');
    expect(out).toContain('- not a bullet');
    expect(out).not.toContain('<li>');
  });

  it('covers inline bold, italic, strike, code and links', () => {
    const out = html('**b** *i* ~~s~~ `c` [text](https://agentnekko.com)');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('>s</s>');
    expect(out).toContain('>c</code>');
    expect(out).toContain('href="https://agentnekko.com"');
  });

  it('auto-links a bare url', () => {
    expect(html('see https://agentnekko.com now')).toContain('href="https://agentnekko.com"');
  });

  it('never renders a link to a script-bearing scheme', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const out = html(`see ${href} and [click](${href})`);
      expect(out).not.toContain('<a ');
      expect(out).not.toContain('href=');
    }
  });

  it('passes only web schemes through the link-target guard', () => {
    expect(safeHref('https://agentnekko.com')).toBe('https://agentnekko.com');
    expect(safeHref('http://agentnekko.com')).toBe('http://agentnekko.com');
    expect(safeHref('mailto:hi@agentnekko.com')).toBe('mailto:hi@agentnekko.com');
    expect(safeHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('not a url')).toBeNull();
  });

  it('leaves snake_case and arithmetic alone', () => {
    const out = html('call some_long_name(x) when 2 * 3 * 4 is odd');
    expect(out).not.toContain('<em>');
    expect(out).toContain('some_long_name(x)');
  });

  it('renders nothing for empty text', () => {
    expect(html('')).not.toContain('<p>');
    expect(html('   \n  ')).not.toContain('<p>');
  });
});

const doc = (text: string) => renderToStaticMarkup(<Markdown text={text} doc />);

describe('Markdown (document mode)', () => {
  it('gives headings a real tag and a size scale', () => {
    expect(doc('# Title')).toContain('<h1');
    expect(doc('## Section')).toContain('<h2');
    expect(doc('###### Deep')).toContain('<h6');
    // Chat mode keeps its flat, quiet headings.
    expect(html('# Title')).not.toContain('<h1');
  });

  it('reflows a hard-wrapped paragraph instead of breaking every line', () => {
    const out = doc('one line\nwrapped here');
    expect(out).toContain('one line wrapped here');
    expect(out).not.toContain('<br/>');
  });

  it('strips embedded HTML down to its text, and drops layout-only lines', () => {
    const out = doc('<div align="center">\n\n# Nekko\n\n</div>');
    expect(out).not.toContain('&lt;div');
    expect(out).toContain('<h1');
    expect(out).toContain('Nekko');
  });

  it('turns an HTML img into the same chip as markdown image syntax', () => {
    const out = doc('<img src="docs/shot.png" alt="A screenshot" />');
    expect(out).toContain('A screenshot');
    expect(out).not.toContain('<img');
  });

  it('hides HTML comments', () => {
    expect(doc('before\n\n<!-- hidden note -->\n\nafter')).not.toContain('hidden note');
  });

  it('renders task lists as checkboxes', () => {
    const out = doc('- [x] shipped\n- [ ] todo');
    expect(out).toContain('☑');
    expect(out).toContain('☐');
    expect(out).not.toContain('[x]');
  });

  it('leaves a relative link as plain text without a document folder', () => {
    const out = doc('see [the guide](CONTRIBUTING.md)');
    expect(out).toContain('the guide');
    expect(out).not.toContain('<a');
  });

  it('does not mistake indexed code for a link', () => {
    expect(html('read rows[0](x) carefully')).toContain('rows[0](x)');
  });
});

// The chat renderer splits text into blocks so a streaming reply re-parses only
// its tail. It has to produce exactly what parsing the whole string produces.
const whole = (text: string) =>
  renderToStaticMarkup(<div className="space-y-1 text-[14px] leading-relaxed">{renderWhole(text, { doc: false })}</div>);

const FIXTURES = [
  'Agent Nekko project.\n- first thing\n- second thing',
  '- top\n  - child\n  - sibling\n- next top',
  'one\ntwo',
  '- bullet\n1. number',
  '1. first\n2. second',
  '## Heading',
  '> quoted',
  '---',
  '| Item | Count |\n| --- | --- |\n| Alpha | 1 |',
  '```ts\n- not a bullet\n```',
  '**b** *i* ~~s~~ `c` [text](https://agentnekko.com)',
  'see https://agentnekko.com now',
  'call some_long_name(x) when 2 * 3 * 4 is odd',
  '',
  '   \n  ',
  'read rows[0](x) carefully',
];

const REPLY = [
  '## Plan',
  '',
  'First I read the **parser** and the `tokenizer`, then:',
  '- split the lexer',
  '  - keep the fast path',
  '- add tests',
  '',
  '   ',
  '> A quote that runs',
  '> over two lines',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| lexer.ts | split |',
  '',
  '```ts',
  'const x = 1;',
  '',
  '- still code',
  '```',
  'Text glued to the fence, then a rule:',
  '---',
  '1. one',
  '2. two',
  '',
  '```',
  'an unlabelled fence',
  '```',
  '',
  'Done: see https://example.com/pr/1.',
].join('\n');

describe('Markdown block split', () => {
  it('renders every fixture exactly as the whole-text parse does', () => {
    for (const text of [...FIXTURES, REPLY]) expect(html(text)).toBe(whole(text));
  });

  it('matches the whole-text parse at every point of a streaming reply', () => {
    // Every prefix, which covers an unterminated fence, a half-typed table row,
    // a list mid-item and a line that is about to become blank.
    for (let n = 0; n <= REPLY.length; n++) {
      const prefix = REPLY.slice(0, n);
      expect(html(prefix), `prefix of ${n} chars`).toBe(whole(prefix));
    }
  });

  it('renders an unterminated fence as code while it streams', () => {
    const out = html('Here:\n\n```ts\nconst a = 1;\n- not yet a bullet');
    expect(out).toContain('<pre');
    expect(out).toContain('- not yet a bullet');
    expect(out).not.toContain('<li>');
  });

  it('leaves finished blocks untouched as a reply grows', () => {
    // A segment is final once another begins after it: its key and source must
    // come out the same in every longer prefix, which is what lets React skip it.
    for (let n = 1; n < REPLY.length; n += 3) {
      const before = markdownSegments(REPLY.slice(0, n));
      const after = markdownSegments(REPLY.slice(0, n + 3));
      for (const seg of before.slice(0, -1)) expect(after).toContainEqual(seg);
    }
  });
});
