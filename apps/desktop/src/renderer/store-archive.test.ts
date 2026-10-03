import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { summarizeSession, type Session } from '@agent-nekko/shared';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});

const { useStore } = await import('./store.js');
const session: Session = { id: 's_test', title: 'Test chat', createdAt: 1, updatedAt: 1, messages: [] };

beforeEach(() => {
  useStore.setState({
    sessions: [summarizeSession(session)], activeSessionId: session.id,
    workspaces: [{ id: 'ws_test', anchor: { kind: 'chat', refId: session.id }, root: { id: 'pane_test', kind: 'chat', refId: session.id }, activePaneId: 'pane_test' }],
    activeWorkspaceId: 'ws_test', toasts: [], archiveOpen: false, archivedViewId: null,
  });
  vi.useFakeTimers();
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function engine(saved: Session | null) {
  window.nekko = {
    abortChat: vi.fn().mockResolvedValue(undefined),
    setSessionOptions: vi.fn().mockResolvedValue(saved),
    listSessionSummaries: vi.fn().mockResolvedValue([summarizeSession(saved ?? session)]),
  } as unknown as typeof window.nekko;
}

describe('completing a workspace', () => {
  it('retains completed chats in the summaries used by Completed', async () => {
    engine({ ...session, archivedAt: 123 });
    await useStore.getState().archiveWorkspace('ws_test');
    expect(useStore.getState().workspaces).toEqual([]);
    expect(useStore.getState().sessions[0].archivedAt).toBe(123);
    expect(useStore.getState().toasts.at(-1)?.kind).toBe('success');
  });

  it.each([session, null])('does not close or announce completion when the engine did not save it (%j)', async (saved) => {
    engine(saved);
    await useStore.getState().archiveWorkspace('ws_test');
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('engine did not save completion') });
  });
});
