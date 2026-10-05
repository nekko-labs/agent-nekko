import React from 'react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: (selector: (state: unknown) => unknown) => selector({ openPrPane: () => {} }) }));
vi.mock('../prPolling.js', () => ({ subscribePrPolling: () => () => {} }));
import { renderToStaticMarkup } from 'react-dom/server';
import { PrActionDock } from './PrCard.js';
import type { PrInfo } from '@agent-nekko/shared';

const url = 'https://github.com/o/r/pull/1';
describe('composer PR deck', () => {
  it('renders a slim expandable deck for chat-created PRs', () => {
    const html = renderToStaticMarkup(<PrActionDock sessionId="test" urls={[url]} prs={[]} />);
    expect(html).toContain('pr-action-deck');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('1 pull request');
    expect(html).toContain('Tuck away');
    expect(html).toContain('Review');
    expect(html).toContain('Hide PR o/r#1');
  });
  it('does not resurrect cached references or resolved PRs', () => {
    expect(renderToStaticMarkup(<PrActionDock sessionId="test" urls={[]} prs={[{ url, state: 'open' } as PrInfo]} />)).toBe('');
    expect(renderToStaticMarkup(<PrActionDock sessionId="test" urls={[url]} prs={[{ url, state: 'merged' } as PrInfo]} />)).toBe('');
  });
});
