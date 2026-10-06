import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplyStatus } from './ReplyStatus.js';

describe('reply measurements', () => {
  it('keeps zero output and elapsed time visible while waiting for generation', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={0} tps={0} out={0} last={null} />);
    expect(html).toContain('tok/s');
    expect(html).toContain('0 total tokens');
    expect(html).toContain('0s');
  });
  it('keeps measurements alongside the completion label', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={{ out: 120, tps: 24, secs: 9 }} done="Finished work" />);
    expect(html).toContain('Done.');
    expect(html).toContain('120 total tokens');
    expect(html).toContain('24');
    expect(html).toContain('9s');
  });
  it('does not invent measurements for an unmeasured chat', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={null} />);
    expect(html).toContain('Time unavailable');
    expect(html).toContain('— total tokens');
  });
});
