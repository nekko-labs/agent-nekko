import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PrInfo } from '@agent-nekko/shared';
import { MAX_INLINE_PRS, SessionPrLinks, prTone } from './SessionPrLinks.js';

const pr = (number: number, state: PrInfo['state'] = 'open', isDraft = false) =>
  ({ url: `https://github.com/o/r/pull/${number}`, owner: 'o', repo: 'r', number, title: `PR ${number}`, state, isDraft } as PrInfo);

describe('session PR links', () => {
  it('shows up to three PRs as separate links', () => {
    const markup = renderToStaticMarkup(<SessionPrLinks prs={[pr(1), pr(2, 'merged'), pr(3, 'closed')]} />);
    expect(MAX_INLINE_PRS).toBe(3);
    expect(markup.match(/<a /g)).toHaveLength(3);
    for (const n of [1, 2, 3]) expect(markup).toContain(`href="https://github.com/o/r/pull/${n}"`);
    expect(markup).toContain('>#2<');
  });

  it('folds more than three into a pull-request glyph and a count', () => {
    const markup = renderToStaticMarkup(<SessionPrLinks prs={[1, 2, 3, 4, 5].map((n) => pr(n))} />);
    expect(markup).not.toContain('<a ');
    expect(markup).toContain('aria-label="5 pull requests from this chat"');
    expect(markup).toContain('>5<');
  });

  it('renders nothing without PRs', () => {
    expect(renderToStaticMarkup(<SessionPrLinks prs={[]} />)).toBe('');
  });

  it('colours a link by the PR state', () => {
    expect(prTone(pr(1))).toBe('var(--success)');
    expect(prTone(pr(1, 'open', true))).toBe('var(--ink-faint)');
    expect(prTone(pr(1, 'merged'))).toBe('#c084fc');
    expect(prTone(pr(1, 'closed'))).toBe('var(--danger)');
  });
});
