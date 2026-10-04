import type { AgentEvent } from '@agent-nekko/shared';
import type { AgentStatus } from '../components/WorkspaceCard.js';

/**
 * What a session is waiting on, beyond simply running: a person (`input`) or
 * nothing at all because it stopped on an error. Whether it is running is read
 * from the live-run registry instead (liveRuns.ts), which has watched every
 * event since launch; the sidebar only sees the events since it mounted.
 */
export type AgentFlag = 'input' | 'error';

/**
 * Fold one event into a session's flag.
 *
 * Bookkeeping events (`session_meta`, `compaction`) leave it alone: they land
 * after `done` too, and treating them as activity is what used to leave a
 * finished chat, or a finished sub-agent, pulsing "working" forever.
 */
export function nextAgentFlag(prev: AgentFlag | undefined, type: AgentEvent['type']): AgentFlag | undefined {
  switch (type) {
    case 'tool_approval_required':
    case 'question':
      return 'input';
    case 'error':
      return 'error';
    case 'session_meta':
    case 'compaction':
      return prev;
    default:
      // done, or the turn moving again (text, tools, an answered question).
      return undefined;
  }
}

/** The status each session shows: a flag wins, otherwise running means working. */
export function mergeAgentStatuses(flags: ReadonlyMap<string, AgentFlag>, running: Iterable<string>): Map<string, AgentStatus> {
  const m = new Map<string, AgentStatus>(flags);
  for (const id of running) if (!m.has(id)) m.set(id, 'working');
  return m;
}
