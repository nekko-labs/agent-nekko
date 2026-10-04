import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '@agent-nekko/shared';
import { completedDate, completedInGroup } from './completedChats.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}) => ({
  id, title: id, createdAt: 1, updatedAt: 1, ...extra,
}) as SessionSummary;

describe('completedDate', () => {
  const now = new Date(2026, 5, 1).getTime();
  it('omits the year inside the current year', () => {
    expect(completedDate(new Date(2026, 11, 20).getTime(), now, 'en-US')).toBe('Dec 20');
  });
  it('includes the year for an earlier year', () => {
    expect(completedDate(new Date(2025, 11, 15).getTime(), now, 'en-US')).toBe('Dec 15, 2025');
  });
});

describe('completedInGroup', () => {
  it('lists only completed top-level chats of the group, newest first', () => {
    const sessions = [
      chat('a', { archivedAt: 10, workspaceId: 'p' }),
      chat('b', { archivedAt: 30, workspaceId: 'p' }),
      chat('c', { workspaceId: 'p' }),
      chat('d', { archivedAt: 20, workspaceId: 'q' }),
      chat('kid', { archivedAt: 40, workspaceId: 'p', parentSessionId: 'b' }),
    ];
    expect(completedInGroup(sessions, 'p', (s) => s.workspaceId ?? '__none').map((s) => s.id)).toEqual(['b', 'a']);
  });
});
