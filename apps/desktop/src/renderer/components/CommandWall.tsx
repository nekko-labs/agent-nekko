import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PendingInput, SessionSummary, TerminalInfo, WorkspaceFolder } from '@agent-nekko/shared';
import { BLOCKED_META, LANE_META, sessionLane } from '@agent-nekko/shared';
import {
  allPanes,
  canSplit,
  isSplit,
  movePane,
  removePane,
  resizeSplit,
  splitPane,
  swapPanes,
  type Direction,
  type PaneKind,
  type WbNode,
  type WbPane,
} from '../layout.js';
import {
  DEFAULT_ASPECT,
  NARROW_ROW_H,
  NARROW_WIDTH,
  WALL_KINDS,
  addPane,
  filterTree,
  hasPane,
  leafRects,
  wallAgents,
  wallPane,
  type CommandWallState,
} from '../commandWall.js';
import { ChatPane } from './ChatPane.js';
import { COMPACT_HEIGHT, COMPACT_WIDTH, PaneDensityHint } from './agent-console/useElementWidth.js';
import { TerminalPane } from './TerminalPane.js';
import { PaneActions, PaneFrame } from './PaneFrame.js';
import { Divider } from './Divider.js';
import { BoltIcon, ChatIcon, ExternalIcon, LayoutIcon, TerminalIcon } from '../icons.js';
import { SHORTCUTS } from '../shortcuts.js';
import { AgentsEmptyArt, EmptyArea } from './EmptyIllustrations.js';

/** The kinds the wall's compass offers, in order. */
const WALL_ADDABLE: PaneKind[] = [...WALL_KINDS];

/**
 * The wall itself: the Command Center's windows in the same split tree the
 * Agent tab arranges its windows in. Every two windows share a draggable
 * divider, every window has a split compass that adds a window on any of its
 * sides, and a window's strip drags onto any side of another (or onto its
 * middle, to trade places). The automations list and the insights box are
 * windows too, placed and sized like the rest.
 *
 * A window waiting on a person (an approval, a question) wears a warm ring and
 * a tinted strip, so it stands out among the windows that are working or idle.
 */
export function CommandWall({
  state,
  setState,
  sessions,
  terminals,
  running,
  pending,
  childrenOf,
  projects,
  flash,
  selectedId,
  onSelect,
  onAspect,
  onOpenChat,
  onOpenTerminal,
  onNewChat,
  onNewTerminal,
  renderPanel,
}: {
  state: CommandWallState;
  setState: (update: (s: CommandWallState) => CommandWallState) => void;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  running: Set<string>;
  pending: Record<string, PendingInput>;
  childrenOf: Map<string, SessionSummary[]>;
  projects: WorkspaceFolder[];
  /** The window the ribbon just jumped to, flashed once. */
  flash: { paneId: string; at: number } | null;
  /** The agent the wall's composer is speaking for. */
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  /** The stage's width over height as it is measured, for placing windows nobody pointed at a side for. */
  onAspect: (aspect: number) => void;
  onOpenChat: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  /** Start a chat; resolves to its id once the session list knows it. */
  onNewChat: () => Promise<string>;
  onNewTerminal: () => Promise<string>;
  renderPanel: (kind: 'automations' | 'insights') => React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<string | null>(null);

  // The wall fills the window from where it starts down to the bottom and
  // re-measures when its box changes (the ribbon appearing, a resize).
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    // Hidden behind another view the wall measures nothing; keep the last real
    // size so its windows stay mounted and warm until it is shown again.
    if (width === 0 || height === 0) return;
    onAspect(width / height);
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, [onAspect]);
  useLayoutEffect(() => {
    measure();
    const el = wrapRef.current;
    const ro = el ? new ResizeObserver(() => measure()) : null;
    if (el && ro) ro.observe(el);
    // A wall mounted while its window had no size (a hidden web tab, a
    // minimised window) gets a second chance when the window resizes or
    // comes back into view, in case the observer's first notice was lost.
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', measure);
    };
  }, [measure]);

  useEffect(() => {
    if (!dragging) return;
    const clear = () => setDragging(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, [dragging]);

  // The ribbon's jump: scroll the window into view, ring it once, and put the
  // caret in its composer so the answer can be typed straight away.
  useEffect(() => {
    if (!flash) return;
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-wall-pane="${flash.paneId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const input = el.querySelector<HTMLElement>('[contenteditable="true"], textarea');
    input?.focus({ preventScroll: true });
  }, [flash]);

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  // The agent windows' numbers, in reading order of the whole wall (not the
  // filtered view), so a number means the same window whatever is shown.
  const numberOf = useMemo(() => new Map(wallAgents(state.root).map((p, i) => [p.refId, i + 1])), [state.root]);
  const terminalById = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : DEFAULT_ASPECT;
  const narrow = size.width > 0 && size.width < NARROW_WIDTH;
  const tree = useMemo(() => filterTree(state.root, state.filter), [state.root, state.filter]);
  // Each window's share of the stage, so a chat can be told it is compact on
  // its first render instead of measuring itself after the fact.
  const rects = useMemo(() => leafRects(tree), [tree]);
  const densityOf = (paneId: string, stacked: boolean): boolean | null => {
    if (stacked) return size.width > 0 ? size.width < COMPACT_WIDTH || NARROW_ROW_H < COMPACT_HEIGHT : null;
    const r = rects.get(paneId);
    if (!r || size.width === 0) return null;
    // The strip takes about 32 px of the window's height.
    return r.width * size.width < COMPACT_WIDTH || r.height * size.height - 32 < COMPACT_HEIGHT;
  };

  const update = useCallback((fn: (root: WbNode | null) => WbNode | null) => setState((s) => {
    const root = fn(s.root);
    return root === s.root ? s : { ...s, root };
  }), [setState]);

  const isRunning = useCallback(
    (s: SessionSummary): boolean => running.has(s.id) || (childrenOf.get(s.id) ?? []).some((k) => isRunning(k)),
    [running, childrenOf],
  );

  /**
   * Put a new window on the given side of `paneId`, or, with no side, beside
   * the biggest window there is. A chat or shell is created first and its id
   * comes back; the panels point at themselves and exist once at most, so
   * asking for one that is already up moves it rather than doubling it.
   */
  const addWindow = async (kind: PaneKind, at?: { paneId: string; dir: Direction }) => {
    let refId: string = kind;
    if (kind === 'chat') refId = await onNewChat();
    else if (kind === 'terminal') refId = await onNewTerminal();
    update((root) => {
      let next = root;
      const existing = allPanes(next).find((p) => p.kind === kind && p.refId === refId);
      // Auto-add may already have placed a brand-new chat; the side the user
      // pointed at wins, so lift it out and put it there.
      if (existing) {
        if (!at) return next;
        next = removePane(next, existing.id);
      }
      const pane = existing ? { ...existing } : wallPane(kind, refId);
      if (at && allPanes(next).some((p) => p.id === at.paneId) && canSplit(next, at.paneId, at.dir)) return splitPane(next, at.paneId, at.dir, pane);
      return addPane(next, pane, aspect);
    });
  };

  const titleOf = (pane: WbPane): string => {
    if (pane.kind === 'chat') return sessionById.get(pane.refId)?.title ?? 'Chat';
    if (pane.kind === 'terminal') return terminalById.get(pane.refId)?.title || 'Terminal';
    return pane.kind === 'automations' ? 'Automations' : 'Insights';
  };
  const iconOf = (kind: PaneKind) => {
    const cls = 'h-3.5 w-3.5 shrink-0 text-ink-faint';
    if (kind === 'terminal') return <TerminalIcon className={cls} />;
    if (kind === 'automations') return <BoltIcon className={cls} />;
    if (kind === 'insights') return <LayoutIcon className={cls} />;
    return <ChatIcon className={cls} />;
  };

  const renderLeaf = (pane: WbPane, stacked: boolean) => {
    const session = pane.kind === 'chat' ? sessionById.get(pane.refId) : undefined;
    const terminal = pane.kind === 'terminal' ? terminalById.get(pane.refId) : undefined;
    const project = projects.find((p) => p.id === (session?.workspaceId ?? terminal?.workspaceId));
    let status: { label: string; tone: string; live?: boolean } | null = null;
    let needsYou = false;
    if (session) {
      const { lane, blocked } = sessionLane({ running: isRunning(session), pending: pending[session.id], stalled: session.stalled });
      needsYou = lane === 'needs-you';
      status = needsYou && blocked ? { label: BLOCKED_META[blocked].label, tone: LANE_META[lane].tone, live: true } : { label: LANE_META[lane].title, tone: LANE_META[lane].tone, live: lane === 'working' };
    } else if (terminal) {
      status = terminal.running ? { label: 'live', tone: 'var(--success)' } : { label: 'exited', tone: 'var(--ink-faint)' };
    }
    const subAgents = session ? (childrenOf.get(session.id)?.length ?? 0) : 0;
    const title = titleOf(pane);
    const flashing = flash?.paneId === pane.id;
    const openable = pane.kind === 'chat' || pane.kind === 'terminal';
    const selected = pane.kind === 'chat' && pane.refId === selectedId;
    const n = pane.kind === 'chat' ? numberOf.get(pane.refId) : undefined;

    return (
      <div
        key={pane.id}
        className={`flex min-h-0 min-w-0 flex-1 rounded-[var(--pane-radius)] ${flashing ? 'pane-flash' : ''}`}
        style={stacked ? { height: NARROW_ROW_H, flex: 'none' } : undefined}
        data-wall-pane={pane.id}
        data-grid-cell={`${pane.kind}:${pane.refId}`}
        data-wall-selected={selected || undefined}
      >
        <PaneFrame
          pane={pane}
          title={title}
          icon={iconOf(pane.kind)}
          badge={
            <>
              {n != null && n <= 9 && <span className="wall-num" title={`Window ${n}: Ctrl+${n} talks to it`}>{n}</span>}
              {/* The project only when there is more than one to tell apart:
                  on a one-project wall it is the same word on every strip. */}
              {project && projects.length > 1 && !densityOf(pane.id, stacked) && <span className="chip hidden shrink-0 text-[10px] sm:inline">{project.name}</span>}
              {status && (
                <span className="flex min-w-0 items-center gap-1 text-[11px]" style={{ color: status.tone }} title={status.label}>
                  {status.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: status.tone }} />}
                  <span className="truncate">{status.label}</span>
                </span>
              )}
              {subAgents > 0 && <span className="chip shrink-0 text-[10px]" title={`${subAgents} sub-agent${subAgents === 1 ? '' : 's'}`}>+{subAgents}</span>}
            </>
          }
          isActive={false}
          ringColor={flashing ? 'color-mix(in srgb, var(--accent) 60%, var(--line))' : undefined}
          stripStyle={needsYou ? { background: 'color-mix(in srgb, var(--warning) 10%, transparent)' } : undefined}
          addable={WALL_ADDABLE}
          closeTitle={openable ? 'Remove from the wall (the chat stays)' : 'Remove from the wall'}
          dragging={dragging}
          canSplit={(dir) => !stacked && canSplit(state.root, pane.id, dir)}
          onSplit={(dir, kind) => { void addWindow(kind, { paneId: pane.id, dir }); }}
          onClose={() => update((root) => removePane(root, pane.id))}
          onFocus={() => { if (pane.kind === 'chat') onSelect(pane.refId); }}
          onDragStart={() => setDragging(pane.id)}
          onDragEnd={() => setDragging(null)}
          onDrop={(target) => {
            if (dragging) update((root) => (target === 'swap' ? swapPanes(root, dragging, pane.id) : movePane(root, dragging, pane.id, target)));
            setDragging(null);
          }}
        >
          {needsYou && <div role="status" className="shrink-0 border-b border-line px-3 py-1 text-[11px]" style={{ color: 'var(--warning)', background: 'color-mix(in srgb, var(--warning) 6%, var(--surface))' }}>{status?.label ?? 'Needs your attention'}</div>}
          {openable && (
            <PaneActions>
              <button
                className="rounded-sm p-1 text-ink-faint hover:text-ink"
                title={`Open ${title}`}
                aria-label={`Open ${title} in the Agent tab`}
                onClick={() => (pane.kind === 'chat' ? onOpenChat(pane.refId) : onOpenTerminal(pane.refId))}
              >
                <ExternalIcon className="h-3 w-3" />
              </button>
            </PaneActions>
          )}
          {pane.kind === 'chat' ? <PaneDensityHint.Provider value={densityOf(pane.id, stacked)}><ChatPane key={pane.refId} sessionId={pane.refId} commandCenter surface="transcript" /></PaneDensityHint.Provider>
            : pane.kind === 'terminal' ? <TerminalPane key={pane.refId} terminalId={pane.refId} />
            : renderPanel(pane.kind as 'automations' | 'insights')}
        </PaneFrame>
      </div>
    );
  };

  const renderNode = (node: WbNode): React.JSX.Element => {
    if (!isSplit(node)) return renderLeaf(node, false);
    return (
      // No `gap`: the Divider between two windows is itself --pane-gap wide.
      // Each child's share is a flex-grow weight, as in the Agent tab.
      <div key={node.id} className={`flex min-h-0 min-w-0 flex-1 ${node.dir === 'row' ? 'flex-row' : 'flex-col'}`}>
        {node.children.map((child, i) => (
          <React.Fragment key={child.id}>
            {i > 0 && <Divider splitId={node.id} index={i - 1} dir={node.dir} onResize={(id, index, fraction) => update((root) => resizeSplit(root, id, index, fraction))} />}
            <div className="flex min-h-0 min-w-0" style={{ flex: `${node.sizes[i]} 1 0` }}>
              {renderNode(child)}
            </div>
          </React.Fragment>
        ))}
      </div>
    );
  };

  if (size.width > 0 && !state.root) {
    return (
      <div ref={wrapRef} className="flex min-h-[360px] flex-1">
        <EmptyArea
          className="flex-1"
          art={<AgentsEmptyArt />}
          title="No agents on the wall yet"
          action={
            <>
              <button className="btn btn-primary" onClick={() => void addWindow('chat')}><ChatIcon className="h-4 w-4" /> New agent <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd></button>
              <button className="btn btn-outline" onClick={() => void addWindow('terminal')}><TerminalIcon className="h-4 w-4" /> New terminal</button>
            </>
          }
        >
          Every agent you start lands here as a live window, terminals too. Split any window on any side, drag the dividers, and answer whatever needs you without leaving the wall.
        </EmptyArea>
      </div>
    );
  }

  if (size.width > 0 && !tree) {
    const what = state.filter === 'terminal' ? 'terminals' : 'agents';
    return (
      <div ref={wrapRef} className="flex min-h-[360px] flex-1">
        <EmptyArea className="flex-1" art={<AgentsEmptyArt />} title={`No ${what} on the wall`}>
          The filter is hiding everything here. Show <span className="font-medium text-ink-soft">All</span>, or add {what === 'terminals' ? 'a terminal' : 'an agent'} from the toolbar.
        </EmptyArea>
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={`flex min-h-0 flex-1 ${narrow ? 'flex-col overflow-y-auto' : ''}`}
      style={{ gap: narrow ? 'var(--pane-gap)' : undefined }}
      data-command-wall={hasPane(state.root, 'insights') ? 'with-insights' : 'windows'}
    >
      {size.width > 0 && tree && (narrow ? allPanes(tree).map((p) => renderLeaf(p, true)) : renderNode(tree))}
    </div>
  );
}
