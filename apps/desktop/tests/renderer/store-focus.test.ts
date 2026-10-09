import { beforeEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.assign(globalThis, { window: { innerWidth: 1280, addEventListener() {} }, localStorage: { getItem: () => null } });
});
const { useStore } = await import('../../src/renderer/store.js');

beforeEach(() => {
  useStore.setState({ sessions: [], activeWorkspaceId: 'one', activeSessionId: 'chat-one', workspaces: [
    { id: 'one', anchor: { kind: 'chat', refId: 'chat-one' }, activePaneId: 'pane-one', root: { id: 'pane-one', kind: 'chat', refId: 'chat-one' } },
    { id: 'two', anchor: { kind: 'chat', refId: 'chat-two' }, activePaneId: 'pane-two', root: { id: 'pane-two', kind: 'chat', refId: 'chat-two' } },
  ] });
});

it('switches to a selected pane without invalidating workspace layout subscribers', () => {
  const before = useStore.getState().workspaces;
  useStore.getState().openChatPane('chat-two');
  expect(useStore.getState().activeWorkspaceId).toBe('two');
  expect(useStore.getState().activeSessionId).toBe('chat-two');
  expect(useStore.getState().workspaces).toBe(before);
});

it('updates the layout when selecting a different pane while retaining other workspaces', () => {
  const before = useStore.getState().workspaces;
  useStore.setState({ workspaces: [before[0], { ...before[1], activePaneId: null }] });
  useStore.getState().openChatPane('chat-two');
  expect(useStore.getState().workspaces[1].activePaneId).toBe('pane-two');
  expect(useStore.getState().workspaces[0]).toBe(before[0]);
});
