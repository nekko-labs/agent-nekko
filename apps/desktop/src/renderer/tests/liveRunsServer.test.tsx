import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { useLiveRunsVersion, useRunningSessionsSnapshot, runningSessionsSnapshot, applyEvent, __resetLiveRuns } from '../liveRuns.js';

it('provides a stable server snapshot for quota consumers rendered on the server', () => {
  function Subscriber() {
    return <span>{useLiveRunsVersion()}</span>;
  }
  expect(renderToStaticMarkup(<Subscriber />)).toBe('<span>0</span>');
});


it('keeps the quota membership snapshot stable across streamed tokens', () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  __resetLiveRuns();
  try {
    applyEvent({ type: 'text', sessionId: 'chat', delta: 'Starting' });
    const active = runningSessionsSnapshot();
    applyEvent({ type: 'text', sessionId: 'chat', delta: ' streaming' });
    expect(runningSessionsSnapshot()).toBe(active);
    applyEvent({ type: 'done', sessionId: 'chat', messageId: 'reply' });
    expect(runningSessionsSnapshot()).toBe('[]');
    function Subscriber() { return <span>{useRunningSessionsSnapshot()}</span>; }
    expect(renderToStaticMarkup(<Subscriber />)).toBe('<span>[]</span>');
  } finally {
    __resetLiveRuns();
    vi.unstubAllGlobals();
  }
});
