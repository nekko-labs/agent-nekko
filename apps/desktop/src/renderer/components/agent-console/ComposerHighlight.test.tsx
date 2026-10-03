import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { composerMarkdownNodes } from './ComposerHighlight.js';

const html = (text: string) => renderToStaticMarkup(<div>{composerMarkdownNodes(text)}</div>);

const ACCENT = 'var(--accent)';
const FAINT = 'var(--ink-faint)';

describe('composerMarkdownNodes', () => {
  it('leaves plain text untouched', () => {
    const out = html('just a sentence');
    expect(out).toContain('just a sentence');
    expect(out).not.toContain(ACCENT);
  });

  it('sizes and emphasizes headings on the editable surface', () => {
    const out = html('## Plan\nbody');
    expect(out).toContain(`color:${ACCENT}">##</span>`);
    expect(out).toContain(' Plan');
    expect(out).toContain('font-size:1.4em');
    expect(out).toContain('font-weight:600');
    expect(out).not.toContain('font-style');
  });

  it('colors list markers, including task boxes', () => {
    const out = html('- one\n  - [ ] two\n3. three');
    expect(out).toContain(`color:${ACCENT}">-</span>`);
    expect(out).toContain(`color:${ACCENT}"> [ ]</span>`);
    expect(out).toContain(`color:${ACCENT}">3.</span>`);
  });

  it('dims blockquote text and tints its marker', () => {
    const out = html('> quoted words');
    expect(out).toContain(`color:${ACCENT}">&gt;</span>`);
    expect(out).toContain('var(--ink-soft)');
  });

  it('dims fenced code lines and leaves their content unstyled', () => {
    const out = html('```\n- not a list\n```\n- a list');
    const fenceCount = (out.match(/color:var\(--ink-faint\)">```/g) ?? []).length;
    expect(fenceCount).toBe(2);
    // Inside the fence the dash is not a list marker; after it, it is.
    expect(out).toContain('- not a list');
    expect(out).toContain(`color:${ACCENT}">-</span>`);
  });

  it('fades emphasis marks and strikes struck text', () => {
    const out = html('**bold** and ~~gone~~');
    expect(out).toContain(`color:${FAINT}">**</span>`);
    expect(out).toContain('bold');
    expect(out).toContain('line-through');
  });

  it('marks inline code without padding, which would shift glyphs', () => {
    const out = html('run `npm test` now');
    expect(out).toContain('npm test');
    expect(out).not.toContain('padding');
  });
});
