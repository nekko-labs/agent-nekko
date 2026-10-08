import type { Session, SessionMeta, WorkspaceFolder } from '@agent-nekko/shared';
import { useStore } from './store.js';

/**
 * Which folders a chat is wired into: one primary (the agent's working
 * directory) plus supporting folders that index search and memory also span.
 * Shared by the Context Inspector's Folders section and the composer's folder
 * picker so both follow the same rules.
 */
export interface FolderSelection {
  primary: string | undefined;
  supporting: string[];
}

type ChatFolders = Pick<SessionMeta, 'workspaceId' | 'supportingWorkspaceIds'> | null | undefined;

/** Make `id` primary; the old primary stays in the chat as supporting. */
export function withPrimary(session: ChatFolders, id: string): FolderSelection {
  return {
    primary: id,
    supporting: [
      ...(session?.workspaceId && session.workspaceId !== id ? [session.workspaceId] : []),
      ...(session?.supportingWorkspaceIds ?? []).filter((wid) => wid !== id),
    ],
  };
}

/** Clear the primary; like a switch, the old primary stays as supporting. */
export function withoutPrimary(session: ChatFolders): FolderSelection {
  return {
    primary: undefined,
    supporting: [...(session?.workspaceId ? [session.workspaceId] : []), ...(session?.supportingWorkspaceIds ?? [])],
  };
}

/** Wire `id` in: primary when the chat has none, otherwise supporting. */
export function withIncluded(session: ChatFolders, id: string): FolderSelection {
  const supporting = session?.supportingWorkspaceIds ?? [];
  if (!session?.workspaceId) return { primary: id, supporting: supporting.filter((wid) => wid !== id) };
  if (session.workspaceId === id || supporting.includes(id)) return { primary: session.workspaceId, supporting };
  return { primary: session.workspaceId, supporting: [...supporting, id] };
}

/** Unwire `id`; dropping the primary promotes the first supporting folder. */
export function withExcluded(session: ChatFolders, id: string): FolderSelection {
  const supporting = session?.supportingWorkspaceIds ?? [];
  if (session?.workspaceId === id) {
    const [primary, ...rest] = supporting;
    return { primary, supporting: rest };
  }
  return { primary: session?.workspaceId, supporting: supporting.filter((wid) => wid !== id) };
}

/**
 * Persist a selection. Both calls are needed: setting the primary drops it from
 * supporting but never demotes the old primary.
 */
export async function applyFolderSelection(sessionId: string, sel: FolderSelection): Promise<Session | null> {
  await window.nekko.setSessionWorkspace(sessionId, sel.primary);
  const updated = await window.nekko.setSessionSupportingWorkspaces(sessionId, sel.supporting);
  await useStore.getState().refreshSessions();
  return updated;
}

/**
 * Pick a folder with the native dialog and wire it into the chat. Returns the
 * updated chat, or null when the dialog was cancelled. Picking a folder that is
 * already registered reuses it rather than keeping the duplicate the host adds.
 */
export async function addFolderToChat(
  sessionId: string,
  session: ChatFolders,
  mode: 'primary' | 'include',
): Promise<Session | null> {
  const before: WorkspaceFolder[] = useStore.getState().settings?.workspaces ?? (await window.nekko.listWorkspaces());
  const after = await window.nekko.addWorkspace();
  const added = after.find((w) => !before.some((b) => b.id === w.id));
  if (!added) return null;

  const existing = before.find((b) => b.path === added.path);
  if (existing) await window.nekko.removeWorkspace(added.id);
  await useStore.getState().refreshSettings();

  const id = existing?.id ?? added.id;
  return applyFolderSelection(sessionId, mode === 'primary' ? withPrimary(session, id) : withIncluded(session, id));
}
