import React from 'react';
import type { Session, TerminalInfo, WorkspaceFolder } from '@agent-nekko/shared';
import { getSessionWorkspaceIds, isLocalProvider } from '@agent-nekko/shared';
import { useStore, type Workspace } from '../store.js';
import { allPanes } from '../layout.js';
import { useProviderLimits } from '../useLimits.js';
import { CloseIcon, FolderIcon, TerminalIcon } from '../icons.js';
import { PrBadge } from './PrCard.js';

/**
 * One workspace, as a card in the left sidebar.
 *
 * What the agent is running used to be a panel at the foot of the sidebar that
 * described whichever chat was open — one card for all of them, four glances
 * away from the chat it was about. The facts belong to the workspace, so they
 * live on the workspace: title and state on the first line, the model and the
 * limit that will stop it on the second, the folders and the windows it holds
 * on the third. Three lines, every card, no panel.
 */

export type AgentStatus = 'working' | 'input' | 'error';

const STATUS_META: Record<AgentStatus, { color: string; label: string; pulse: boolean }> = {
  working: { color: 'var(--accent)', label: 'Working…', pulse: true },
  input: { color: 'var(--warning)', label: 'Needs your input', pulse: true },
  error: { color: 'var(--danger)', label: 'Stopped on an error', pulse: false },
};

export function StatusDot({ status, className = '' }: { status: AgentStatus; className?: string }) {
  const m = STATUS_META[status];
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.pulse ? 'animate-pulse' : ''} ${className}`}
      style={{ background: m.color }}
      title={m.label}
    />
  );
}

export function WorkspaceCard({
  workspace,
  session,
  terminal,
  status,
  isActive,
  projects,
  onOpen,
  onClose,
}: {
  workspace: Workspace;
  /** The chat the workspace is about, when it is about one. */
  session: Session | null;
  /** The terminal it is about instead, for a workspace opened from a shell. */
  terminal: TerminalInfo | null;
  status: AgentStatus | undefined;
  isActive: boolean;
  projects: WorkspaceFolder[];
  onOpen: () => void;
  onClose: () => void;
}) {
  const providers = useStore((s) => s.providers);
  const prs = useStore((s) => (session ? s.prsBySession[session.id] : undefined));
  const provider = providers.find((p) => p.id === session?.providerId);
  const limits = useProviderLimits(provider);

  // The window closest to being spent, which is the one that will stop the run.
  const binding = [...(limits?.windows ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];

  const folders = (session ? getSessionWorkspaceIds(session) : terminal?.workspaceId ? [terminal.workspaceId] : [])
    .map((id) => projects.find((w) => w.id === id))
    .filter((w): w is WorkspaceFolder => !!w);

  const windows = allPanes(workspace.root).length;
  const title = session?.title ?? terminal?.title ?? 'Workspace';
  const model = session
    ? session.autoModel
      ? 'Auto'
      : session.modelId ?? 'No model yet'
    : terminal
      ? terminal.shell.split(/[\\/]/).pop() || terminal.shell
      : 'Shell';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group w-full cursor-pointer rounded-lg px-2 py-1.5 text-left transition-colors duration-150 ${
        isActive ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
      title={title}
    >
      <div className="flex items-center gap-1.5">
        {status ? (
          <StatusDot status={status} />
        ) : (
          <span
            aria-hidden
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: isActive ? 'var(--accent)' : 'var(--ink-faint)' }}
          />
        )}
        <span className={`min-w-0 flex-1 truncate text-[13px] ${isActive ? 'font-medium text-ink' : 'text-ink-soft'}`}>
          {title}
        </span>
        {prs?.length ? <PrBadge prs={prs} compact /> : null}
        <button
          className="shrink-0 rounded-sm p-0.5 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          title="Close this workspace"
          aria-label={`Close ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      </div>

      {/* Two dense lines of detail, in the same order every card states them. */}
      <div className="mt-px flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
        {terminal && !session && <TerminalIcon className="h-2.5 w-2.5 shrink-0" />}
        <span className="min-w-0 truncate" title={`${model}${provider ? ` · ${provider.label}` : ''}`}>
          {model}
        </span>
        {provider && (
          <span className="shrink-0">· {isLocalProvider(provider.kind) ? 'local' : provider.label}</span>
        )}
        {terminal && !terminal.running && (
          <span className="shrink-0" style={{ color: 'var(--danger)' }}>· exited</span>
        )}
        {binding && (
          <span
            className="shrink-0"
            title={`${binding.label} window, ${Math.round(binding.usedPercent)}% used`}
            style={{
              color:
                binding.status === 'rate_limited'
                  ? 'var(--danger)'
                  : binding.status === 'warning'
                    ? 'var(--warning)'
                    : undefined,
            }}
          >
            · {Math.round(binding.usedPercent)}%
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
        {folders.length === 0 ? (
          <span className="truncate">No project attached</span>
        ) : (
          <>
            <FolderIcon className="h-2.5 w-2.5 shrink-0" />
            <span className="min-w-0 truncate" title={folders.map((f) => f.path).join('\n')}>
              {folders.map((f) => f.name).join(', ')}
            </span>
          </>
        )}
        <span className="shrink-0">· {windows === 1 ? '1 window' : `${windows} windows`}</span>
      </div>
    </div>
  );
}
