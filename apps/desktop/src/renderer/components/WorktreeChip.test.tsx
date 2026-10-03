import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: { getState: () => ({}) } }));
import type { GitStatus, Session } from '@agent-nekko/shared';
import { WorktreeChip } from './WorktreeChip.js';

const session = { id: 'chat', gitIsolation: true } as Session;
const git = { repo: true, worktree: { name: 'silver-puffin', path: '/repo/worktree' } } as GitStatus;

describe('worktree chip', () => {
  it('offers an accessible hover/focus checkout control without placing the notice in the transcript', () => {
    const html = renderToStaticMarkup(<WorktreeChip session={session} git={git} disabled={false} onChange={() => {}} />);
    expect(html).toContain('aria-label="Git checkout options"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('silver-puffin');
    expect(html).not.toContain('Existing local changes');
  });

  it('keeps the control available after switching to the current branch', () => {
    const html = renderToStaticMarkup(<WorktreeChip session={{ ...session, gitIsolation: false }} git={git} disabled={false} onChange={() => {}} />);
    expect(html).toContain('Current branch');
    expect(html).not.toContain('silver-puffin');
  });
});
