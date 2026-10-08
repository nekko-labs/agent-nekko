import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { IncognitoIcon } from '../icons.js';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('incognito icon', () => {
  it('is the hat-and-sunglasses glyph: a brim, a hat crown and two round lenses with a bridge', () => {
    const svg = renderToStaticMarkup(<IncognitoIcon />);
    expect(svg).toContain('d="M2 11h20"');
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg).toContain('d="M10.5 17a2.1 2.1 0 0 1 3 0"');
  });
  it('replaces the old mask everywhere', () => {
    expect(read('./ChatControls.tsx')).toContain('<IncognitoIcon className="h-3.5 w-3.5" />');
    expect(read('../icons.tsx')).not.toContain('MaskIcon');
  });
});

describe('title bar slot observer', () => {
  it('watches only the host ancestors, never the whole body subtree', () => {
    const view = read('../views/CommandCenterView.tsx');
    expect(view).not.toContain("observer.observe(document.body, { childList: true, subtree: true });");
    expect(view).toContain('observer.observe(ancestor, { childList: true });');
  });
});
