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

  it('keeps children reachable when their parent is saved but has no sidebar workspace', () => {

    expect(unopenedChats([chat('parent'), chat('child', { parentSessionId: 'parent' })], [])
      .map((s) => s.id)).toEqual(['parent', 'child']);
  });

  it('excludes only children actually rendered beneath an open anchor', () => {
    const sessions = [chat('parent'), chat('running', { parentSessionId: 'parent' }), chat('finished', { parentSessionId: 'parent', lastReplyText: 'Done' })];
    expect(unopenedChats(sessions, [workspace('parent')], new Set(['running']))
      .map((s) => s.id)).toEqual(['finished']);
  });

  it('keeps split-pane chats reachable because only the anchor has a sidebar card', () => {
    const w = workspace('anchor');
    w.root = { id: 'split', dir: 'row', sizes: [0.5, 0.5], children: [
      w.root!, { id: 'pane_split-chat', kind: 'chat', refId: 'split-chat' },
    ] };
    expect(unopenedChats([chat('anchor'), chat('split-chat')], [w]).map((s) => s.id)).toEqual(['split-chat']);
  });

  it('keeps orphaned and archived-parent children reachable', () => {
    const sessions = [chat('parent', { archivedAt: 100 }), chat('child', { parentSessionId: 'parent' }), chat('orphan', { parentSessionId: 'missing' })];
    expect(unopenedChats(sessions, []).map((s) => s.id)).toEqual(['child', 'orphan']);
  });
});
