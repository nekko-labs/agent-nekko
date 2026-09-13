import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, safeHref } from './Markdown.js';

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe('Markdown', () => {
  it('turns a dashed run glued to a sentence into a real list', () => {
    // The shape people actually type into the composer: a lead-in line with no
    // blank line before the dashes.
    const out = html('kotrain project.\n- first thing\n- second thing');
    expect(out).toContain('<p>kotrain project.</p>');
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
    const out = html('**b** *i* ~~s~~ `c` [text](https://kotrain.com)');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('<em>i</em>');
    expect(out).toContain('>s</s>');
    expect(out).toContain('>c</code>');
    expect(out).toContain('href="https://kotrain.com"');
  });

  it('auto-links a bare url', () => {
    expect(html('see https://kotrain.com now')).toContain('href="https://kotrain.com"');
  });

  it('never renders a link to a script-bearing scheme', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const out = html(`see ${href} and [click](${href})`);
      expect(out).not.toContain('<a ');
      expect(out).not.toContain('href=');
    }
  });

  it('passes only web schemes through the link-target guard', () => {
    expect(safeHref('https://kotrain.com')).toBe('https://kotrain.com');
    expect(safeHref('http://kotrain.com')).toBe('http://kotrain.com');
    expect(safeHref('mailto:hi@kotrain.com')).toBe('mailto:hi@kotrain.com');
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
