import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: { getState: () => ({}) } }));
import type { GitStatus, Session } from '@agent-nekko/shared';
import { claimCheckoutNotice, WorktreeChip } from './WorktreeChip.js';

const session = { id: 'chat', gitIsolation: true } as Session;
const git = { repo: true, worktree: { name: 'silver-puffin', path: '/repo/worktree' } } as GitStatus;

describe('worktree chip', () => {
  it('shows the automatic notice once per chat and persists the claim', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    expect(claimCheckoutNotice('first-chat', storage)).toBe(true);
    expect(values.get('nekko:checkout-notice:first-chat')).toBe('shown');
    expect(claimCheckoutNotice('first-chat', storage)).toBe(false);
    values.set('nekko:checkout-notice:previous-chat', 'shown');
    expect(claimCheckoutNotice('previous-chat', storage)).toBe(false);
    expect(claimCheckoutNotice('another-chat', storage)).toBe(true);
  });

  it('does not repeat on remount when local storage is unavailable', () => {
    const storage = { getItem: () => { throw new Error('disabled'); }, setItem: () => {} };
    expect(claimCheckoutNotice('private-chat', storage)).toBe(true);
    expect(claimCheckoutNotice('private-chat', storage)).toBe(false);
  });

  it('offers an accessible hover/focus checkout control without placing the notice in the transcript', () => {
    const html = renderToStaticMarkup(<WorktreeChip session={session} git={git} disabled={false} onChange={() => {}} />);
    expect(html).toContain('aria-label="Git checkout options"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('silver-puffin');
    expect(html).not.toContain('Existing local changes');
  });

  it('keeps the control available after switching to the current branch', () => {
    const html = renderToStaticMarkup(<WorktreeChip session={{ ...session, gitIsolation: false }} git={git} disabled={false} onChange={() => {}} />);
    expect(html).toContain('detached');
    expect(html).not.toContain('silver-puffin');
  });
});
