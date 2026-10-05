import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: Object.assign(vi.fn(() => vi.fn()), { getState: vi.fn() }) }));
import type { PrInfo } from '@agent-nekko/shared';
import { PrCard, PrActionDock } from './PrCard.js';
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
  it('celebrates merges with static decorative autumn confetti', () => {
    const markup = renderToStaticMarkup(<PrCard url={url} info={pr} event="merged" />);
    expect(markup).toContain('🎃');
    expect(markup).toContain('🍁');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('animate-pulse');
    expect(markup).not.toContain('✦');
    expect(renderToStaticMarkup(<PrCard url={url} info={pr} />)).not.toContain('🎃');
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
  it('uses adjoining rows at 80% composer width with actions beside the PR details', () => {
    const second = { ...pr, url: 'https://github.com/o/r/pull/2', number: 2 };
    const markup = renderToStaticMarkup(<PrActionDock sessionId="s" prs={[pr, second]} urls={[url]} />);
    expect(markup).toContain('mx-auto max-h-60 w-[80%]');
    expect(markup.match(/data-pr-actions=/g)).toHaveLength(2);
    expect(markup.match(/last:border-b-0/g)).toHaveLength(2);
    expect(markup).not.toContain('mb-2');
    expect(markup).not.toContain('mt-1');
    expect(markup).toContain('justify-end gap-0');
    expect(markup).toContain('</p></div><div class="flex max-w-[55%]');
  });
  it.each(['merged', 'closed'] as const)('automatically removes a %s PR from the dock', (state) => {
    expect(renderToStaticMarkup(<PrActionDock sessionId="s" prs={[{ ...pr, state }]} urls={[url]} />)).toBe('');
  });
});
