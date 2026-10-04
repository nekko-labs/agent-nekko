import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import { ContextGauge, formatContextTokens } from './ChatMetrics.js';

describe('context token formatting', () => {
  it.each([[999, '999'], [1000, '1.0k'], [177000, '177k'], [1000000, '1m'], [1500000, '1.5m'], [2000000, '2m']])('formats %i as %s', (tokens, label) => {
    expect(formatContextTokens(Number(tokens))).toBe(label);
  });
  it('shows a million-token window as 1m while retaining exact accessible counts', () => {
    const html = renderToStaticMarkup(<ContextGauge bundle={null} draftTokens={177000} contextWindow={1000000} windowReported />);
    expect(html).toContain('177k / 1m');
    expect(html).not.toContain('1000k');
    expect(html).toContain('177,000 of 1,000,000 tokens in use');
  });
});
