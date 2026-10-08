import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { useLiveRunsVersion } from '../liveRuns.js';

it('provides a stable server snapshot for quota consumers rendered on the server', () => {
  function Subscriber() {
    return <span>{useLiveRunsVersion()}</span>;
  }
  expect(renderToStaticMarkup(<Subscriber />)).toBe('<span>0</span>');
});
