import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: Object.assign(vi.fn(() => vi.fn()), { getState: vi.fn() }) }));
import type { PrInfo } from '@agent-nekko/shared';
import { PrCard, PrActionDock, PrBadge } from './PrCard.js';
const url = 'https://github.com/o/r/pull/1';
const pr = { url, owner: 'o', repo: 'r', number: 1, title: 'A change', state: 'open', checks: 'pending', source: 'gh' } as PrInfo;
describe('PR milestones and composer actions', () => {
  it('keeps the created card historical even when live state is merged', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={{ ...pr, state: 'merged' }} event="created" />);
    expect(markup).toContain('PR created');
    expect(markup).not.toContain('Approve');
    expect(markup).not.toContain('Merge</button>');
    expect(markup).not.toContain('PR merged');
  });
  it.each(['closed', 'merged'] as const)('renders the %s milestone without actions', (event) => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event={event} />);
    expect(markup).toContain(`PR ${event}`);
    expect(markup).not.toContain('<button');
  });
  it('colours the merged banner from theme tokens, not fixed light violets', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={{ ...pr, state: 'merged' }} event="merged" />);
    expect(markup).toContain('var(--merged-wash)');
    expect(markup).toContain('var(--merged-line)');
    expect(markup).toContain('color:var(--merged-ink)');
    expect(markup).toContain('var(--merged-star)');
    // Light violets only read on dark paper; on light paper they vanish.
    expect(markup).not.toMatch(/violet-(50|100|200)|#c084fc|rgba\(147,\s*51,\s*234/);
  });
  it('colours the merged badge from theme tokens', () => {
    const markup = renderToStaticMarkup(<PrBadge prs={[{ ...pr, state: 'merged' }]} />);
    expect(markup).toContain('var(--merged-chip)');
    expect(markup).toContain('var(--merged-ink)');
    expect(markup).not.toContain('#c084fc');
  });
  it('places actions and a non-destructive hide button on the open dock', () => {
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr]} urls={[url]} />);
    expect(markup).toContain('Pending pull requests');
    expect(markup).toContain('Approve');
    expect(markup).toContain('Decline');
    expect(markup).toContain('Review');
    expect(markup).toContain('Hide PR o/r#1');
    expect(markup).toContain('does not close the PR');
  });
  it.each(['merged', 'closed'] as const)('automatically removes a %s PR from the dock', (state) => {
    expect(renderToStaticMarkup(<PrActionDock sessionId="s" prs={[{ ...pr, state }]} urls={[url]} />)).toBe('');
  });
});
