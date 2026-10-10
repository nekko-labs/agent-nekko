import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../store.js', () => ({ useStore: vi.fn() }));
import type { PrInfo } from '@nekko-agent/shared';
import { PrBadge } from './PrCard.js';

const pr = (state: PrInfo['state']) => ({ state } as PrInfo);

describe('compact PR summary', () => {
  it('shows all states rather than hiding merged or closed counts', () => {
    const markup = renderToStaticMarkup(<PrBadge compact prs={[pr('merged'), pr('merged'), pr('open'), pr('closed')]} />);
    expect(markup).toContain('2 merged, 1 open, 1 closed PRs');
    expect(markup.match(/<svg/g)).toHaveLength(4);
    expect(markup).not.toContain('PR ready');
  });

  it('shows a closed-only summary and omits empty summaries', () => {
    expect(renderToStaticMarkup(<PrBadge compact prs={[pr('closed')]} />)).toContain('0 merged, 0 open, 1 closed PRs');
    expect(renderToStaticMarkup(<PrBadge compact prs={[]} />)).toBe('');
  });
});
