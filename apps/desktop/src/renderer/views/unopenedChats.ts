import type { SessionSummary } from '@agent-nekko/shared';
import type { Workspace } from '../store.js';
import { allPanes } from '../layout.js';

/**
 * Active (not completed) top-level chats with no open window. The sidebar lists
 * them as ordinary agent cards: a chat stays active until it is completed.
 */
export function unopenedChats(sessions: SessionSummary[], workspaces: Workspace[]): SessionSummary[] {
  const openIds = new Set(workspaces.flatMap((w) => allPanes(w.root)
    .filter((p) => p.kind === 'chat').map((p) => p.refId)));
  const sessionIds = new Set(sessions.map((s) => s.id));
  return sessions.filter((s) => !s.archivedAt && !openIds.has(s.id) &&
    (!s.parentSessionId || !sessionIds.has(s.parentSessionId)));
}
