import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsageLimitsChip } from './UsageLimitsChip.js';
const provider = { id: 'plan', kind: 'chatgpt' as const, label: 'ChatGPT', baseUrl: '', enabled: true, auth: 'subscription' as const };
describe('composer API-equivalent cost', () => {
  it('labels subscription estimates without changing metered amounts', () => {
    expect(renderToStaticMarkup(<UsageLimitsChip provider={provider} cost={4.89} />)).toContain('Subscription ($4.89)');
    const metered = renderToStaticMarkup(<UsageLimitsChip provider={{ ...provider, auth: 'apikey' }} cost={4.89} />);
    expect(metered).toContain('$4.89');
    expect(metered).not.toContain('Subscription ($4.89)');
  });
  it('shows a list-price total rather than the zero subscription bill', () => {
    const html = renderToStaticMarkup(<UsageLimitsChip provider={provider} cost={24} turnCost={2} running />);
    expect(html).toContain('$26.00');
    expect(html).toContain('your plan covers it');
  });
  it('never presents unpriced usage as zero cost', () => {
    const html = renderToStaticMarkup(<UsageLimitsChip provider={provider} unpriced />);
    expect(html).toContain('No estimate');
    expect(html).toContain('Unpriced tokens are excluded, not free');
    expect(html).toContain('Unavailable');
  });
  it('labels partial totals and leaves local models free', () => {
    expect(renderToStaticMarkup(<UsageLimitsChip provider={provider} cost={2} unpriced />)).toContain('$2.00+');
    expect(renderToStaticMarkup(<UsageLimitsChip provider={{ ...provider, kind: 'ollama' }} unpriced />)).toContain('Free');
  });
});
