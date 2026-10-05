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

describe('deleting an open chat', () => {
  function deletion(fail = false) {
    window.nekko = {
      abortChat: vi.fn().mockResolvedValue(undefined),
      deleteSession: fail ? vi.fn().mockRejectedValue(new Error('disk error')) : vi.fn().mockResolvedValue(undefined),
      listSessionSummaries: vi.fn().mockResolvedValue(fail ? [summarizeSession(session)] : []),
    } as unknown as typeof window.nekko;
  }

  it('stops the run and removes the anchored workspace after successful deletion', async () => {
    deletion();
    await useStore.getState().deleteChatForever(session.id);
    expect(window.nekko.abortChat).toHaveBeenCalledWith(session.id);
    expect(window.nekko.deleteSession).toHaveBeenCalledWith(session.id);
    expect(vi.mocked(window.nekko.abortChat).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(window.nekko.deleteSession).mock.invocationCallOrder[0]);
    expect(useStore.getState().workspaces).toEqual([]);
    expect(useStore.getState().activeSessionId).toBeNull();
    expect(useStore.getState().sessions).toEqual([]);
  });

  it('removes only the deleted chat pane from another workspace', async () => {
    deletion();
    const terminal = { id: 'term-pane', kind: 'terminal' as const, refId: 'term-1' };
    useStore.setState({ workspaces: [{
      id: 'ws_other', anchor: { kind: 'terminal', refId: 'term-1' }, activePaneId: 'pane_test',
      root: { id: 'split', dir: 'row', sizes: [0.5, 0.5], children: [terminal, { id: 'pane_test', kind: 'chat', refId: session.id }] },
    }], activeWorkspaceId: 'ws_other' });
    await useStore.getState().deleteChatForever(session.id);
    expect(useStore.getState().workspaces[0]).toMatchObject({ root: terminal, activePaneId: terminal.id });
    expect(useStore.getState().activeWorkspaceId).toBe('ws_other');
  });

  it('preserves open panes and reports failed deletion', async () => {
    deletion(true);
    await useStore.getState().deleteChatForever(session.id);
    expect(useStore.getState().workspaces).toHaveLength(1);
    expect(useStore.getState().activeSessionId).toBe(session.id);
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('disk error') });
  });

  it('Close only removes the pane and preserves the session', () => {
    engine(session);
    useStore.getState().closePane('pane_test');
    expect(useStore.getState().sessions).toHaveLength(1);
    expect(window.nekko.abortChat).not.toHaveBeenCalled();
    expect(window.nekko.setSessionOptions).not.toHaveBeenCalled();
  });
});

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
