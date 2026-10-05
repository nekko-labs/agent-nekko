import type { SessionSummary } from '@agent-nekko/shared';
import type { Workspace } from '../store.js';

/** Chats without a sidebar row remain available, even if open in a split pane. */
export function unopenedChats(sessions: SessionSummary[], workspaces: Workspace[], visibleChildIds: ReadonlySet<string> = new Set()): SessionSummary[] {
  // The sidebar renders workspace anchors, not every pane in their split tree.
  const anchorIds = new Set(workspaces.filter((w) => w.anchor.kind === 'chat').map((w) => w.anchor.refId));
  return sessions.filter((s) => !s.archivedAt && !anchorIds.has(s.id) && !visibleChildIds.has(s.id));

}
