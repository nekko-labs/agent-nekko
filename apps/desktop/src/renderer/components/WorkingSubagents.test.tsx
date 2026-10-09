import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { SessionSummary } from '@agent-nekko/shared';
import { WorkingSubagents } from './WorkingSubagents.js';

it('appears at bottom right only for running children with accessible expand control', () => {
  const child = { id: 'child', title: 'Tests' } as SessionSummary;
  const props = { children: [child], pending: {}, onOpen: () => {} };
  expect(renderToStaticMarkup(<WorkingSubagents {...props} running={new Set()} />)).toBe('');
  const html = renderToStaticMarkup(<WorkingSubagents {...props} running={new Set(['child'])} />);
  expect(html).toContain('bottom-3 right-3');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('var(--success)');
  expect(html).not.toContain('Tests');
});
