import React from 'react';
import type { SessionSummary } from '@agent-nekko/shared';
import { StatusDot, type AgentStatus } from './WorkspaceCard.js';

/** The tree line's colour: present enough to follow, quiet enough to ignore. */
const BRANCH_LINE = 'color-mix(in srgb, var(--ink-faint) 45%, transparent)';

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: 'Working…',
  input: 'Needs your input',
  error: 'Stopped on an error',
};

/**
 * One sub-agent under its parent's card: a single line, no details of its own.
 *
 * A branch drawn down from the parent's status-dot column ends in an arrowhead
 * at the child's own status dot, so which chat spawned it reads at a glance.
 * The last child's branch turns the corner; earlier ones carry the trunk on.
 */
export function SubAgentRow({
  session, status, isActive, isLast, onOpen,
}: {
  session: SessionSummary;
  status: AgentStatus | undefined;
  isActive: boolean;
  /** The last child under its parent, where the trunk stops. */
  isLast: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="relative pl-[30px]">
      <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-[30px]">
        {/* Down from the row above, round the corner, across to the arrow. */}
        <span
          className="absolute left-[11px] top-0 h-1/2 w-[12px] rounded-bl-[5px] border-b border-l"
          style={{ borderColor: BRANCH_LINE }}
        />
        {!isLast && <span className="absolute bottom-0 left-[11px] top-1/2 border-l" style={{ borderColor: BRANCH_LINE }} />}
        <svg
          className="absolute left-[21px] top-1/2 h-[7px] w-[5px] -translate-y-1/2"
          viewBox="0 0 5 7" fill="none" stroke={BRANCH_LINE} strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M1 1l3 2.5L1 6" />
        </svg>
      </span>
      <button
        onClick={onOpen}
        title={`${session.title}\n${status ? STATUS_LABEL[status] : 'Idle'}`}
        className={`flex w-full items-center gap-2 rounded-lg py-1 pl-1 pr-2 text-left text-[12px] transition-colors duration-150 ${
          isActive ? 'bg-accent-soft text-ink' : 'text-ink-soft hover:bg-surface-2'
        }`}
      >
        {status ? (
          <StatusDot status={status} />
        ) : (
          <span
            aria-hidden
            className={`h-1.5 w-1.5 shrink-0 rounded-full bg-transparent ring-1 ${isActive ? 'ring-accent' : 'ring-ink-faint'}`}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
      </button>
    </div>
  );
}
