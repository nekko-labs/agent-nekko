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
