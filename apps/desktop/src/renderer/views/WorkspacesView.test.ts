import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@agent-nekko/shared';
import type { Workspace } from '../store.js';
import { unopenedChats } from './unopenedChats.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}) => ({
  id, title: id, createdAt: 1, updatedAt: 1, ...extra,
}) as SessionSummary;

const workspace = (id: string): Workspace => ({
  id: `ws_${id}`, anchor: { kind: 'chat', refId: id },
  root: { id: `pane_${id}`, kind: 'chat', refId: id }, activePaneId: `pane_${id}`,
});

describe('unopenedChats', () => {
  it('keeps active chats listed after their workspace is closed, without duplicating open chats', () => {
    const sessions = [chat('old'), chat('open'), chat('archived', { archivedAt: 100 })];
    expect(unopenedChats(sessions, [workspace('open')]).map((s) => s.id)).toEqual(['old']);
    expect(unopenedChats(sessions, []).map((s) => s.id)).toEqual(['old', 'open']);
  });

  it('does not list a child separately while its parent is listed', () => {
    expect(unopenedChats([chat('parent'), chat('child', { parentSessionId: 'parent' })], [])
      .map((s) => s.id)).toEqual(['parent']);
  });
});
