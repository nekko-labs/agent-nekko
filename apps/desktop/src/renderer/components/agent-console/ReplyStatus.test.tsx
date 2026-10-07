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
  it('shows a watch-backed idle deadline, rounding minutes and using hours above an hour', () => {
    const base = { streaming: false, status: '', elapsed: 0, tps: 0, out: 0, last: null, done: 'Finished work', now: 100000 };
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now + 60_000} />)).toContain('Sleeping · will check in 1 min');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now + 61 * 60_000} />)).toContain('Sleeping · will check in 2 hours');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now + 3 * 3600_000} />)).toContain('Sleeping · will check in 3 hours');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={base.now - 1000} />)).toContain('Sleeping · will check in 1 min');
    expect(renderToStaticMarkup(<ReplyStatus {...base} nextWakeAt={null} />)).toContain('Done.');
  });
  it('keeps active and blocked states ahead of sleeping', () => {
    const base = { status: 'Working', elapsed: 0, tps: 0, out: 0, last: null, nextWakeAt: 200000, now: 100000 };
    const active = renderToStaticMarkup(<ReplyStatus {...base} streaming />);
    expect(active).toContain('Working');
    expect(active).not.toContain('Sleeping');
    const blocked = renderToStaticMarkup(<ReplyStatus {...base} streaming={false} blocked="Waiting for approval" done="Finished" />);
    expect(blocked).toContain('Waiting for approval');
    expect(blocked).not.toContain('Sleeping');
  });
  it('does not invent measurements for an unmeasured chat', () => {
    const html = renderToStaticMarkup(<ReplyStatus streaming={false} status="" elapsed={0} tps={0} out={0} last={null} />);
    expect(html).toContain('Time unavailable');
    expect(html).toContain('— total tokens');
  });
});

it('labels provisional streaming rates as estimates', () => {
  const html = renderToStaticMarkup(<ReplyStatus streaming status="Working" elapsed={2} tps={24} out={0} last={null} estimatedRate />);
  expect(html).toContain('~24');
  expect(html).toContain('Estimated tokens per second');
});
