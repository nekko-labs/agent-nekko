import { afterEach, describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { Object.assign(globalThis, { window: {}, localStorage: { getItem: () => null } }); });
import type { WorkspaceFolder } from '@agent-nekko/shared';
import { useStore } from './store.js';
import { addFolderToChat, withExcluded, withIncluded, withoutPrimary, withPrimary } from './sessionFolders.js';

const folder = (id: string, path = `/code/${id}`): WorkspaceFolder => ({ id, name: id, path, addedAt: 0 });

describe('folder selection rules', () => {
  it('demotes the old primary to supporting', () => {
    expect(withPrimary({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }, 'c')).toEqual({ primary: 'c', supporting: ['a', 'b'] });
    expect(withPrimary(null, 'a')).toEqual({ primary: 'a', supporting: [] });
    expect(withPrimary({ workspaceId: 'a' }, 'a')).toEqual({ primary: 'a', supporting: [] });
  });

  it('clears the primary and keeps it as supporting', () => {
    expect(withoutPrimary({ workspaceId: 'a', supportingWorkspaceIds: ['b'] })).toEqual({ primary: undefined, supporting: ['a', 'b'] });
    expect(withoutPrimary({})).toEqual({ primary: undefined, supporting: [] });
  });

  it('includes as primary only when the chat has none', () => {
    expect(withIncluded({}, 'a')).toEqual({ primary: 'a', supporting: [] });
    expect(withIncluded({ workspaceId: 'a' }, 'b')).toEqual({ primary: 'a', supporting: ['b'] });
    expect(withIncluded({ workspaceId: 'a', supportingWorkspaceIds: ['b'] }, 'b')).toEqual({ primary: 'a', supporting: ['b'] });
  });

  it('promotes the first supporting folder when the primary is excluded', () => {
    expect(withExcluded({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }, 'a')).toEqual({ primary: 'b', supporting: ['c'] });
    expect(withExcluded({ workspaceId: 'a', supportingWorkspaceIds: ['b', 'c'] }, 'c')).toEqual({ primary: 'a', supporting: ['b'] });
    expect(withExcluded({ workspaceId: 'a' }, 'a')).toEqual({ primary: undefined, supporting: [] });
  });
});

describe('adding a folder to a chat', () => {
  const prev = useStore.getState();
  afterEach(() => { useStore.setState({ settings: prev.settings, refreshSettings: prev.refreshSettings, refreshSessions: prev.refreshSessions }); });

  const setup = (before: WorkspaceFolder[], after: WorkspaceFolder[]) => {
    const api = {
      addWorkspace: vi.fn(async () => after),
      removeWorkspace: vi.fn(async () => before),
      setSessionWorkspace: vi.fn(async () => null),
      setSessionSupportingWorkspaces: vi.fn(async () => ({ id: 's' })),
    };
    (globalThis as any).window.nekko = api;
    useStore.setState({ settings: { workspaces: before } as any, refreshSettings: vi.fn(async () => {}), refreshSessions: vi.fn(async () => {}) });
    return api;
  };

  it('does nothing when the dialog is cancelled', async () => {
    const api = setup([folder('a')], [folder('a')]);
    expect(await addFolderToChat('s', { workspaceId: 'a' }, 'primary')).toBeNull();
    expect(api.setSessionWorkspace).not.toHaveBeenCalled();
  });

  it('makes the new folder primary and keeps the old one', async () => {
    const api = setup([folder('a')], [folder('a'), folder('b')]);
    await addFolderToChat('s', { workspaceId: 'a' }, 'primary');
    expect(api.setSessionWorkspace).toHaveBeenCalledWith('s', 'b');
    expect(api.setSessionSupportingWorkspaces).toHaveBeenCalledWith('s', ['a']);
  });

  it('reuses an already registered path instead of the duplicate', async () => {
    const api = setup([folder('a'), folder('b')], [folder('a'), folder('b'), folder('dup', '/code/b')]);
    await addFolderToChat('s', { workspaceId: 'a' }, 'include');
    expect(api.removeWorkspace).toHaveBeenCalledWith('dup');
    expect(api.setSessionWorkspace).toHaveBeenCalledWith('s', 'a');
    expect(api.setSessionSupportingWorkspaces).toHaveBeenCalledWith('s', ['b']);
  });
});
