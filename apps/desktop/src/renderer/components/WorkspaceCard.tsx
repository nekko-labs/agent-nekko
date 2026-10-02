import React, { memo } from 'react';
import type { PrInfo, SessionSummary, TerminalInfo, WorkspaceFolder } from '@agent-nekko/shared';
import { getSessionWorkspaceIds, guessContextWindow, isLocalProvider } from '@agent-nekko/shared';
import { useStore, type Workspace } from '../store.js';
import { allPanes } from '../layout.js';
import { useGitStatus } from '../useGitStatus.js';
import { ArchiveIcon, BranchIcon, CloseIcon, FolderIcon, RobotIcon, TerminalIcon, WorktreeIcon } from '../icons.js';
import { PrBadge } from './PrCard.js';

/**
 * One workspace, as a card in the left sidebar.
 *
 * What the agent is running used to be a panel at the foot of the sidebar that
 * described whichever chat was open — one card for all of them, four glances
 * away from the chat it was about. The facts belong to the workspace, so they
 * live on the workspace.
 *
 * The card states them in a fixed order, so the same fact is always in the same
 * place and a column of cards can be read down rather than each one decoded:
 *
 * 1. **Who and how it is.** Status dot, title, PR badges.
 * 2. **What is running it.** Where the model comes from and which model it is
 *    ("Claude / Opus 5.5"), and how full its context window is.
 * 3. **Where it is working.** The project folder, the git worktree when it is
 *    one, the branch, and how dirty that branch is. The branch's PR joins the
 *    PR badges on line 1.
 * 4. **What it has spun up.** Sub-agents and windows.
 *
 * Colour is load-bearing rather than decorative. Every fact carries the hue of
 * what it *is* (a branch is always the same colour, a limit is the colour of
 * how close to spent it is), so the eye can find the branch without reading.
 * A chat workspace gets an accent spine and a tinted active state; a terminal
 * workspace deliberately does not, because the chat is the thing this app is
 * about and a sidebar where everything shouts says nothing.
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

/**
 * One fact on a card: a tinted glyph and its value, in the hue of whatever kind
 * of fact it is. Tinted rather than filled, so a card with five of them still
 * reads as one card.
 */
function Fact({
  tone,
  icon,
  children,
  title,
  grow = false,
  shrink = false,
}: {
  tone?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  title?: string;
  /** Whether this fact absorbs the spare width (and truncates) on its line. */
  grow?: boolean;
  /** Whether it may give up width (truncating) when the line runs out. */
  shrink?: boolean;
}) {
  const fluid = grow || shrink;
  return (
    <span
      className={`inline-flex items-center gap-1 ${grow ? 'min-w-0 flex-1' : shrink ? 'min-w-0 shrink' : 'shrink-0'}`}
      style={tone ? { color: tone } : undefined}
      title={title}
    >
      {icon}
      <span className={fluid ? 'min-w-0 truncate' : undefined}>{children}</span>
    </span>
  );
}

/** The colour a context window earns by how full it is. */
function fillTone(percent: number): string {
  if (percent >= 90) return 'var(--danger)';
  if (percent >= 70) return 'var(--warning)';
  if (percent >= 40) return 'var(--info)';
  return 'var(--success)';
}

/** "4.5k" / "312k" / "1M" for a tight card line. */
function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * A model id as a card can say it. The provider already names the vendor on
 * the same line, so "claude-opus-5-5" reads as "Opus 5.5" beside "Claude".
 */
function shortModelName(id: string, known?: string): string {
  if (known) return known.replace(/^Claude\s+/i, '');
  const claude = /^(?:.*\/)?claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id);
  if (claude) {
    const family = claude[1][0].toUpperCase() + claude[1].slice(1).toLowerCase();
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`;
  }
  return id;
}

/** PRs by URL, the branch's own first, so one PR is never counted twice. */
function mergePrs(branchPr: PrInfo | undefined, mentioned: PrInfo[] | undefined): PrInfo[] {
  const out = new Map<string, PrInfo>();
  if (branchPr) out.set(branchPr.url, branchPr);
  for (const p of mentioned ?? []) if (!out.has(p.url)) out.set(p.url, p);
  return [...out.values()];
}

function timeAgo(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
}

function WorkspaceCardImpl({
  workspace,
  session,
  terminal,
  status,
  isActive,
  now,
  projects,
  subAgentCount = 0,
  onOpen,
  onClose,
}: {
  workspace: Workspace;
  /** The chat the workspace is about, when it is about one. */
  session: SessionSummary | null;
  /** The terminal it is about instead, for a workspace opened from a shell. */
  terminal: TerminalInfo | null;
  status: AgentStatus | undefined;
  isActive: boolean;
  now: number;
  projects: WorkspaceFolder[];
  /** How many sub-agents this chat has spawned. */
  subAgentCount?: number;
  onOpen: () => void;
  onClose: () => void;
}) {
  const providers = useStore((s) => s.providers);
  const knownModels = useStore((s) => s.models);
  const mentionedPrs = useStore((s) => (session ? s.prsBySession[session.id] : undefined));
  const liveCtxEstimate = useStore((s) => (session ? s.sessionCtxEstimate[session.id] : undefined));
  const provider = providers.find((p) => p.id === session?.providerId);

  const folders = (session ? getSessionWorkspaceIds(session) : terminal?.workspaceId ? [terminal.workspaceId] : [])
    .map((id) => projects.find((w) => w.id === id))
    .filter((w): w is WorkspaceFolder => !!w);

  // Git follows the workspace's primary folder: a chat grounded in several
  // repos still *works* in one at a time, and a card has room for one branch.
  const git = useGitStatus(folders[0]?.id);
  const prs = mergePrs(git?.pr, mentionedPrs);
  const worktreeIsFolder = !!git?.worktree && folders.length === 1 && folders[0].name === git.worktree.name;

  // How full this chat's context window is: the replayed transcript (text,
  // reasoning, tool traffic) against the model's window. That is the limit a
  // long run actually hits, and it is per chat, where a plan's usage limit is
  // per account and has its own Capacity panel.
  const modelInfo = session?.modelId ? knownModels.find((m) => m.id === session.modelId) : undefined;
  const ctxUsed = status === 'working' && liveCtxEstimate != null
    ? liveCtxEstimate
    : session?.transcriptTokens ?? 0;
  const ctxWindow = modelInfo?.contextLength ?? guessContextWindow(session?.modelId);
  const ctxPct = ctxWindow > 0 ? (ctxUsed / ctxWindow) * 100 : 0;

  const windows = allPanes(workspace.root).length;
  const lastReply = session?.lastReplyAt;
  const title = session?.title ?? terminal?.title ?? 'Workspace';
  const isChat = !!session;
  const model = session
    ? session.chatType === 'image'
      ? `🎨 ${session.imageParams?.modelId ? (session.imageParams.modelId.split('/').pop() as string) : 'No image model yet'}`
      : session.autoModel
      ? 'Auto'
      : session.modelId
        ? shortModelName(session.modelId, modelInfo?.name)
        : 'No model yet'
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
      /* The spine: a chat workspace carries an accent edge that fills in when it
         is the active one, so the thing this app is about is findable in a
         column of cards without reading a word of any of them. */
      className={`group w-full cursor-pointer rounded-lg border-l py-1.5 pl-2 pr-2 text-left transition-colors duration-150 ${
        isActive ? 'bg-accent-soft' : 'hover:bg-surface-2'
      }`}
      style={{
        borderLeftColor: isChat
          ? isActive
            ? 'var(--accent)'
            : 'color-mix(in srgb, var(--accent) 30%, transparent)'
          : 'transparent',
      }}
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
        {lastReply && !status && (
          <time className="shrink-0 text-[10px] tabular-nums text-ink-faint" dateTime={new Date(lastReply).toISOString()} title={`Last reply ${new Date(lastReply).toLocaleString()}`}>
            {timeAgo(now - lastReply)}
          </time>
        )}
        {prs.length ? <PrBadge prs={prs} compact /> : null}
        {/* A chat card archives rather than closes: closing used to look like
            deleting and then the chat was nowhere to be found. Archived chats
            stay readable for 60 days. A shell has nothing to keep, so it closes. */}
        <button
          className="shrink-0 rounded-sm p-0.5 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
          title={isChat ? 'Archive this chat (kept for 60 days)' : 'Close this workspace'}
          aria-label={isChat ? `Archive ${title}` : `Close ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          {isChat ? <ArchiveIcon className="h-3 w-3" /> : <CloseIcon className="h-3 w-3" />}
        </button>
      </div>

      {/* Line 2: what is running it: "source / model", then how full the
          context window is. Source first because it answers "whose quota is
          this spending" before "which model", and the two read as one fact. */}
      <div className="mt-0.5 flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
        <Fact
          grow
          tone={isChat ? 'var(--accent-2)' : 'var(--success)'}
          icon={isChat ? undefined : <TerminalIcon className="h-2.5 w-2.5 shrink-0" />}
          title={`${provider ? `${provider.label} / ` : ''}${session?.modelId ?? model}`}
        >
          {provider && (
            <span className="opacity-70">{isLocalProvider(provider.kind) ? 'Local' : provider.label} / </span>
          )}
          {model}
        </Fact>
        {terminal && !terminal.running && (
          <Fact tone="var(--danger)" title="This shell has exited">exited</Fact>
        )}
        {isChat && ctxUsed > 0 && (
          <Fact
            tone={fillTone(ctxPct)}
            title={`Context window: about ${ctxUsed.toLocaleString()} of ${ctxWindow.toLocaleString()} tokens (${ctxPct < 1 ? '<1' : Math.round(ctxPct)}%)`}
          >
            {compactTokens(ctxUsed)}/{compactTokens(ctxWindow)}
          </Fact>
        )}
      </div>

      {/* Line 3: where it is working: the project, and its git position. */}
      <div className="flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
        {folders.length === 0 ? (
          <span className="min-w-0 flex-1 truncate">No project attached</span>
        ) : worktreeIsFolder ? (
          // The project folder *is* the worktree (the usual arrangement), so it
          // is one fact with the worktree's glyph rather than the same name twice.
          <Fact
            grow
            tone="var(--accent-2)"
            icon={<WorktreeIcon className="h-2.5 w-2.5 shrink-0" />}
            title={`Linked git worktree: ${git!.worktree!.path}`}
          >
            {folders[0].name}
          </Fact>
        ) : (
          <Fact
            grow
            tone="var(--info)"
            icon={<FolderIcon className="h-2.5 w-2.5 shrink-0" />}
            title={folders.map((f) => f.path).join('\n')}
          >
            {folders.map((f) => f.name).join(', ')}
          </Fact>
        )}
        {git && (
          <>
            {git.worktree && !worktreeIsFolder && (
              <Fact
                tone="var(--accent-2)"
                icon={<WorktreeIcon className="h-2.5 w-2.5 shrink-0" />}
                title={`Linked git worktree: ${git.worktree.path}`}
              >
                {git.worktree.name}
              </Fact>
            )}
            <Fact
              shrink
              tone="var(--accent)"
              icon={<BranchIcon className="h-2.5 w-2.5 shrink-0" />}
              title={
                git.branch
                  ? `On branch ${git.branch}` +
                    (git.ahead || git.behind ? ` · ${git.ahead} ahead, ${git.behind} behind upstream` : '')
                  : `Detached at ${git.head}`
              }
            >
              {git.branch ?? git.head ?? 'detached'}
            </Fact>
            {/* Uncommitted work is the one git fact that is about *risk*, so it
                gets the warning hue rather than the branch's accent. */}
            {git.dirtyCount > 0 && (
              <Fact
                tone="var(--warning)"
                title={`${git.dirtyCount} uncommitted file${git.dirtyCount === 1 ? '' : 's'}`}
              >
                {git.dirtyCount}●
              </Fact>
            )}
            {(git.ahead > 0 || git.behind > 0) && (
              <Fact
                tone="var(--info)"
                title={`${git.ahead} ahead of, ${git.behind} behind, the upstream branch`}
              >
                {git.ahead > 0 ? `↑${git.ahead}` : ''}
                {git.behind > 0 ? `↓${git.behind}` : ''}
              </Fact>
            )}
          </>
        )}
      </div>

      {/* Line 4: what it has spun up. Only when there is something to say: a
          card for a plain one-window chat should not carry an empty row. */}
      {(subAgentCount > 0 || windows > 1) && (
        <div className="flex items-center gap-1 pl-3 text-[10px] leading-[15px] text-ink-faint">
          {subAgentCount > 0 && (
            <Fact
              tone="var(--accent-2)"
              icon={<RobotIcon className="h-2.5 w-2.5 shrink-0" />}
              title={`${subAgentCount} sub-agent${subAgentCount === 1 ? '' : 's'} spawned by this chat`}
            >
              {subAgentCount} sub-agent{subAgentCount === 1 ? '' : 's'}
            </Fact>
          )}
          {windows > 1 && <span className="shrink-0">{windows} windows</span>}
        </div>
      )}
    </div>
  );
}

type CardProps = React.ComponentProps<typeof WorkspaceCardImpl>;

/**
 * Memoized, so switching workspaces repaints the two cards whose state changed
 * rather than the whole column. The handlers are left out of the comparison:
 * the sidebar passes fresh closures every render, and each one only closes over
 * this card's workspace id and store actions, which are compared (or stable).
 */
export const WorkspaceCard = memo(WorkspaceCardImpl, (a: CardProps, b: CardProps) => {
  for (const key of Object.keys(b) as Array<keyof CardProps>) {
    if (key === 'onOpen' || key === 'onClose') continue;
    if (a[key] !== b[key]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
});
