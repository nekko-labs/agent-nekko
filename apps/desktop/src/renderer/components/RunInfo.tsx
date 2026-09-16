import React from 'react';
import type { PrInfo, Session, WorkspaceFolder } from '@agent-nekko/shared';
import { getSessionWorkspaceIds, isLocalProvider } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { useProviderLimits } from '../useLimits.js';
import { CheckIcon, FolderIcon, WarningIcon } from '../icons.js';

/**
 * What the open chat is actually running, at the foot of the workbench sidebar.
 *
 * Every fact here already existed somewhere — the model in a chip below the
 * composer, the PR as a badge in the header, the folders in the panel on the
 * far right, the status as a dot on a sidebar row — which is the problem: the
 * answer to "what is this agent doing, on what, and where" took four glances
 * across the width of the window. One card, always in the same place.
 */

type RunState = 'working' | 'input' | 'error' | 'idle';

const STATE_META: Record<RunState, { label: string; color: string; pulse: boolean }> = {
  working: { label: 'Working', color: 'var(--accent)', pulse: true },
  input: { label: 'Waiting on you', color: 'var(--warning)', pulse: true },
  error: { label: 'Stopped on an error', color: 'var(--danger)', pulse: false },
  idle: { label: 'Idle', color: 'var(--ink-faint)', pulse: false },
};

export function RunInfo({
  session,
  state,
  workspaces,
}: {
  session: Session | null;
  state: RunState;
  workspaces: WorkspaceFolder[];
}) {
  const providers = useStore((s) => s.providers);
  const prs = useStore((s) => (session ? s.prsBySession[session.id] : undefined));
  const openPrPane = useStore((s) => s.openPrPane);

  const provider = providers.find((p) => p.id === session?.providerId);
  const limits = useProviderLimits(provider);
  const meta = STATE_META[state];

  const modelLabel = session?.autoModel
    ? 'Auto'
    : session?.modelId ?? (session ? 'No model yet' : '—');

  // The window closest to being spent, which is the one that will stop the run.
  const binding = [...(limits?.windows ?? [])].sort((a, b) => b.usedPercent - a.usedPercent)[0];

  const wsIds = session ? getSessionWorkspaceIds(session) : [];
  const folders = wsIds
    .map((id) => workspaces.find((w) => w.id === id))
    .filter((w): w is WorkspaceFolder => !!w);

  if (!session) {
    return (
      <div className="border-t border-line px-3 py-2.5">
        <p className="text-[11px] leading-snug text-ink-faint">Open a chat to see what it is running.</p>
      </div>
    );
  }

  return (
    <div className="shrink-0 border-t border-line px-3 py-2.5 text-[11px]">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.pulse ? 'animate-pulse' : ''}`}
          style={{ background: meta.color }}
        />
        <span className="min-w-0 flex-1 truncate font-semibold uppercase tracking-wide text-ink-faint">
          {session.title}
        </span>
      </div>

      <Row label="Status">
        <span style={{ color: state === 'idle' ? undefined : meta.color }}>{meta.label}</span>
      </Row>

      <Row label="Model">
        <span className="truncate" title={`${modelLabel} · ${provider?.label ?? 'no provider'}`}>
          {modelLabel}
        </span>
        {provider && (
          <span className="shrink-0 text-ink-faint">
            · {isLocalProvider(provider.kind) ? 'local' : provider.label}
          </span>
        )}
      </Row>

      {binding && (
        <Row label="Limits">
          <span
            title={`${binding.label} window, ${Math.round(binding.usedPercent)}% used`}
            style={{ color: binding.status === 'rate_limited' ? 'var(--danger)' : binding.status === 'warning' ? 'var(--warning)' : undefined }}
          >
            {Math.round(binding.usedPercent)}% of {binding.label}
          </span>
        </Row>
      )}

      <Row label={folders.length === 1 ? 'Project' : 'Projects'}>
        {folders.length === 0 ? (
          <span className="text-ink-faint">None attached</span>
        ) : (
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {folders.map((f) => (
              <span key={f.id} className="flex min-w-0 items-center gap-0.5" title={f.path}>
                <FolderIcon className="h-3 w-3 shrink-0 text-ink-faint" />
                <span className="truncate">{f.name}</span>
                {f.id === session.workspaceId && folders.length > 1 && (
                  <span className="shrink-0 text-ink-faint">(primary)</span>
                )}
              </span>
            ))}
          </span>
        )}
      </Row>

      {!!prs?.length && (
        <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
          {prs.slice(0, 3).map((pr) => (
            <PrLine key={pr.url} pr={pr} onOpen={() => openPrPane(pr.url)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5 py-px">
      <span className="w-14 shrink-0 text-ink-faint">{label}</span>
      <span className="flex min-w-0 flex-1 items-baseline gap-1 truncate text-ink-soft">{children}</span>
    </div>
  );
}

/** One PR with its review + check state, as a link into the PR pane. */
function PrLine({ pr, onOpen }: { pr: PrInfo; onOpen: () => void }) {
  const stateColor =
    pr.state === 'merged' ? '#c084fc' : pr.state === 'closed' ? 'var(--ink-faint)' : 'var(--accent)';
  const checkIcon =
    pr.checks === 'passing' ? <CheckIcon className="h-3 w-3" />
      : pr.checks === 'failing' ? <WarningIcon className="h-3 w-3" />
        : null;
  const checkColor =
    pr.checks === 'passing' ? 'var(--success)' : pr.checks === 'failing' ? 'var(--danger)' : 'var(--warning)';
  return (
    <button
      className="flex w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left hover:bg-surface-2"
      onClick={onOpen}
      title={`${pr.title} — ${pr.state}${pr.checks !== 'none' ? `, checks ${pr.checks}` : ''}`}
    >
      <span className="shrink-0" style={{ color: stateColor }}>⑂ {pr.number}</span>
      <span className="min-w-0 flex-1 truncate text-ink-soft">{pr.title}</span>
      {pr.reviewDecision === 'APPROVED' && (
        <span className="shrink-0 text-[10px]" style={{ color: 'var(--success)' }}>approved</span>
      )}
      {pr.checks !== 'none' && (
        <span className="shrink-0" style={{ color: checkColor }} title={`Checks ${pr.checks}`}>
          {checkIcon ?? '●'}
        </span>
      )}
    </button>
  );
}

export type { RunState };
