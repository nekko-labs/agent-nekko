import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PendingInput, SessionSummary, TerminalInfo, WorkspaceFolder } from '@agent-nekko/shared';
import { BLOCKED_META, LANE_META, isArchived, sessionLane } from '@agent-nekko/shared';
import {
  GRID_GAP,
  NARROW_WIDTH,
  addCells,
  gridShape,
  layoutRects,
  removeCell,
  resizeTracks,
  sameCell,
  swapCells,
  tracksFor,
  visibleCells,
  type CommandGridState,
  type GridCell,
} from '../commandGrid.js';
import { ChatPane } from './ChatPane.js';
import { TerminalPane } from './TerminalPane.js';
import { PaneSlots } from './PaneFrame.js';
import { ChatIcon, CloseIcon, ExternalIcon, PlusIcon, TerminalIcon } from '../icons.js';
import { SHORTCUTS } from '../shortcuts.js';
import { AgentsEmptyArt, EmptyArea } from './EmptyIllustrations.js';

const CELL_DRAG_TYPE = 'application/x-nekko-grid-cell';
/** A phone-width grid stacks its windows; each gets this much height. */
const NARROW_ROW_H = 420;
/** The grid never collapses below this, whatever the window height. */
const MIN_GRID_H = 360;
/** The grid wall's reserved margin under the viewport, so it ends above the scrollbar's bottom. */
const BOTTOM_MARGIN = 20;

/**
 * The grid itself: live chat and terminal windows in a consistent grid of
 * resizable tracks, a plus cell last. Measures its own box, lets auto mode
 * pick a shape, and draws dividers between every two columns and rows that
 * drag the shared edge, so one cell can be made wider or taller than its
 * neighbours without the grid losing its lines.
 */
export function CommandGrid({
  state,
  setState,
  sessions,
  terminals,
  running,
  pending,
  childrenOf,
  projects,
  onOpenChat,
  onOpenTerminal,
  onNewChat,
  onNewTerminal,
}: {
  state: CommandGridState;
  setState: (update: (s: CommandGridState) => CommandGridState) => void;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  running: Set<string>;
  pending: Record<string, PendingInput>;
  childrenOf: Map<string, SessionSummary[]>;
  projects: WorkspaceFolder[];
  onOpenChat: (id: string) => void;
  onOpenTerminal: (id: string) => void;
  onNewChat: () => Promise<void>;
  onNewTerminal: () => Promise<void>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState<GridCell | null>(null);
  // Track fractions mid-drag live here so the whole page is not re-saved on
  // every pointer move; they are committed to state when the drag ends.
  const [liveTracks, setLiveTracks] = useState<{ axis: 'col' | 'row'; fr: number[] } | null>(null);

  // The grid fills the window from where it starts down to the bottom, and
  // re-measures whenever its box or the window changes (the insights box
  // above it opening, a sidebar, a resize).
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.max(MIN_GRID_H, Math.round(window.innerHeight - rect.top - BOTTOM_MARGIN));
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = wrapRef.current;
    const ro = el ? new ResizeObserver(() => measure()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);
  // Anything above the grid changing height moves its top edge; one frame later it is settled.
  useEffect(() => { const t = requestAnimationFrame(measure); return () => cancelAnimationFrame(t); });

  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const terminalById = useMemo(() => new Map(terminals.map((t) => [t.id, t])), [terminals]);
  const cells = visibleCells(state.cells, state.filter);
  const count = cells.length + 1; // the plus cell
  const narrow = size.width > 0 && size.width < NARROW_WIDTH;
  const { cols, rows } = gridShape(state.layout, count, size.width, size.height);
  const colFr = liveTracks?.axis === 'col' ? liveTracks.fr : tracksFor(state.colSizes, cols);
  const rowFr = liveTracks?.axis === 'row' ? liveTracks.fr : tracksFor(state.rowSizes, rows);
  const gridH = narrow ? count * NARROW_ROW_H + GRID_GAP * (count - 1) : size.height;
  const { rects, totalHeight } = layoutRects(count, cols, rows, colFr, rowFr, size.width, gridH);

  const isRunning = useCallback(
    (s: SessionSummary): boolean => running.has(s.id) || (childrenOf.get(s.id) ?? []).some((k) => isRunning(k)),
    [running, childrenOf],
  );

  // Divider drags: pointer capture on the gutter, fractions of the inner size.
  const startTrackDrag = (axis: 'col' | 'row', index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const origin = axis === 'col' ? e.clientX : e.clientY;
    const inner = axis === 'col' ? size.width - GRID_GAP * (cols - 1) : gridH - GRID_GAP * (rows - 1);
    const base = axis === 'col' ? tracksFor(state.colSizes, cols) : tracksFor(state.rowSizes, rows);
    let current = base;
    const onMove = (ev: PointerEvent) => {
      const delta = ((axis === 'col' ? ev.clientX : ev.clientY) - origin) / Math.max(1, inner);
      current = resizeTracks(base, index, delta);
      setLiveTracks({ axis, fr: current });
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      setLiveTracks(null);
      setState((s) => (axis === 'col' ? { ...s, colSizes: { ...s.colSizes, [String(cols)]: current } } : { ...s, rowSizes: { ...s.rowSizes, [String(rows)]: current } }));
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  // Gutters sit on the shared edges of the first `rows` rows and all columns.
  const colGutters: number[] = [];
  for (let c = 0; c < cols - 1; c++) colGutters.push(rects[c] ? rects[c].x + rects[c].width : 0);
  const rowGutters: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    const first = rects[r * cols];
    if (first) rowGutters.push(first.y + first.height);
  }

  const titleOf = (cell: GridCell): string =>
    cell.kind === 'chat' ? sessionById.get(cell.refId)?.title ?? 'Chat' : terminalById.get(cell.refId)?.title || 'Terminal';

  const transition = liveTracks ? 'none' : 'left 160ms ease, top 160ms ease, width 160ms ease, height 160ms ease';

  if (size.width > 0 && state.cells.length === 0) {
    return (
      <div ref={wrapRef} style={{ minHeight: MIN_GRID_H }} className="flex">
        <EmptyArea
          className="flex-1"
          art={<AgentsEmptyArt />}
          title="No agents on the wall yet"
          action={
            <>
              <button className="btn btn-primary" onClick={() => void onNewChat()}><ChatIcon className="h-4 w-4" /> New agent <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd></button>
              <button className="btn btn-outline" onClick={() => void onNewTerminal()}><TerminalIcon className="h-4 w-4" /> New terminal</button>
            </>
          }
        >
          Every agent you start lands here as a live window, terminals too. Watch them all at once, answer one, stop another, and resize the grid to suit.
        </EmptyArea>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className="relative" style={{ height: size.width ? totalHeight : MIN_GRID_H }}>
      {size.width > 0 && cells.map((cell, i) => {
        const rect = rects[i];
        const session = cell.kind === 'chat' ? sessionById.get(cell.refId) : undefined;
        const terminal = cell.kind === 'terminal' ? terminalById.get(cell.refId) : undefined;
        const project = projects.find((p) => p.id === (session?.workspaceId ?? terminal?.workspaceId));
        let status: { label: string; tone: string; live?: boolean } | null = null;
        if (session) {
          const { lane, blocked } = sessionLane({ running: isRunning(session), pending: pending[session.id], stalled: session.stalled });
          status = lane === 'needs-you' && blocked ? { label: BLOCKED_META[blocked].label, tone: LANE_META[lane].tone } : { label: LANE_META[lane].title, tone: LANE_META[lane].tone, live: lane === 'working' };
        } else if (terminal) {
          status = terminal.running ? { label: 'live', tone: 'var(--success)' } : { label: 'exited', tone: 'var(--ink-faint)' };
        }
        return (
          <GridCellFrame
            key={`${cell.kind}:${cell.refId}`}
            cell={cell}
            rect={rect}
            transition={transition}
            title={titleOf(cell)}
            projectName={project?.name}
            status={status}
            subAgents={session ? (childrenOf.get(session.id)?.length ?? 0) : 0}
            dragging={dragging}
            onDragStart={() => setDragging(cell)}
            onDragEnd={() => setDragging(null)}
            onDrop={(from) => { setState((s) => swapCells(s, from, cell)); setDragging(null); }}
            onOpen={() => (cell.kind === 'chat' ? onOpenChat(cell.refId) : onOpenTerminal(cell.refId))}
            onRemove={() => setState((s) => removeCell(s, cell))}
          >
            {cell.kind === 'chat' ? <ChatPane sessionId={cell.refId} /> : <TerminalPane terminalId={cell.refId} />}
          </GridCellFrame>
        );
      })}
      {size.width > 0 && (
        <PlusCell
          rect={rects[cells.length]}
          transition={transition}
          sessions={sessions}
          terminals={terminals}
          inGrid={state.cells}
          onNewChat={onNewChat}
          onNewTerminal={onNewTerminal}
          onAdd={(add) => setState((s) => addCells(s, add))}
        />
      )}
      {!narrow && colGutters.map((x, c) => (
        <div
          key={`col-${c}`}
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize columns ${c + 1} and ${c + 2}`}
          className="group absolute top-0 z-10 flex cursor-col-resize justify-center"
          style={{ left: x, width: GRID_GAP, height: totalHeight, touchAction: 'none' }}
          onPointerDown={startTrackDrag('col', c)}
          title="Drag to resize"
        >
          <div className="h-full w-px transition-colors group-hover:w-[3px]" style={{ background: 'transparent' }} />
          <div className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100" style={{ background: 'var(--accent)' }} />
        </div>
      ))}
      {!narrow && rowGutters.map((y, r) => (
        <div
          key={`row-${r}`}
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize rows ${r + 1} and ${r + 2}`}
          className="group absolute left-0 z-10 cursor-row-resize"
          style={{ top: y, height: GRID_GAP, width: size.width, touchAction: 'none' }}
          onPointerDown={startTrackDrag('row', r)}
          title="Drag to resize"
        >
          <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100" style={{ background: 'var(--accent)' }} />
        </div>
      ))}
    </div>
  );
}

/* ---------- a cell ---------- */

function GridCellFrame({
  cell,
  rect,
  transition,
  title,
  projectName,
  status,
  subAgents,
  dragging,
  onDragStart,
  onDragEnd,
  onDrop,
  onOpen,
  onRemove,
  children,
}: {
  cell: GridCell;
  rect: { x: number; y: number; width: number; height: number };
  transition: string;
  title: string;
  projectName?: string;
  status: { label: string; tone: string; live?: boolean } | null;
  subAgents: number;
  dragging: GridCell | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (from: GridCell) => void;
  onOpen: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const [metadataSlot, setMetadataSlot] = useState<HTMLElement | null>(null);
  const [over, setOver] = useState(false);
  const targeting = dragging !== null && !sameCell(dragging, cell);
  const Icon = cell.kind === 'chat' ? ChatIcon : TerminalIcon;

  return (
    <div
      className="panel panel-ring absolute flex flex-col overflow-hidden"
      style={{
        left: rect.x, top: rect.y, width: rect.width, height: rect.height, transition,
        '--panel-ring-color': over ? 'var(--accent)' : 'var(--line)',
      } as React.CSSProperties}
      data-grid-cell={`${cell.kind}:${cell.refId}`}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1"
        style={{ cursor: 'grab' }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(CELL_DRAG_TYPE, JSON.stringify(cell));
          e.dataTransfer.setData('text/plain', title);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        title="Drag onto another window to trade places"
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 max-w-[40%] truncate text-[12px] font-medium">{title}</span>
        {status && (
          <span className="flex shrink-0 items-center gap-1 text-[11px]" style={{ color: status.tone }}>
            {status.live && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: status.tone }} />}
            {status.label}
          </span>
        )}
        {subAgents > 0 && <span className="chip shrink-0 text-[10px]" title={`${subAgents} sub-agent${subAgents === 1 ? '' : 's'}`}>+{subAgents}</span>}
        {projectName && <span className="chip hidden shrink-0 text-[10px] sm:inline">{projectName}</span>}
        <div ref={setMetadataSlot} className="flex min-w-0 items-center gap-1" />
        <div className="min-w-0 flex-1" />
        <div ref={setActionSlot} className="flex shrink-0 items-center gap-0.5" />
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title={`Open ${title}`} aria-label={`Open ${title} in the Agent tab`} onClick={onOpen}>
          <ExternalIcon className="h-3 w-3" />
        </button>
        <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Remove from the grid (the chat stays)" aria-label={`Remove ${title} from the grid`} onClick={onRemove}>
          <CloseIcon className="h-3 w-3" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col">
          <PaneSlots actions={actionSlot} metadata={metadataSlot}>{children}</PaneSlots>
        </div>
        {targeting && (
          <div
            className="absolute inset-0 z-20"
            style={over ? { background: 'color-mix(in srgb, var(--accent) 12%, transparent)' } : undefined}
            onDragOver={(e) => { if (!e.dataTransfer.types.includes(CELL_DRAG_TYPE)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              try { onDrop(JSON.parse(e.dataTransfer.getData(CELL_DRAG_TYPE)) as GridCell); } catch { /* not ours */ }
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------- the plus cell ---------- */

function PlusCell({
  rect,
  transition,
  sessions,
  terminals,
  inGrid,
  onNewChat,
  onNewTerminal,
  onAdd,
}: {
  rect: { x: number; y: number; width: number; height: number };
  transition: string;
  sessions: SessionSummary[];
  terminals: TerminalInfo[];
  inGrid: GridCell[];
  onNewChat: () => Promise<void>;
  onNewTerminal: () => Promise<void>;
  onAdd: (cells: GridCell[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const has = (kind: GridCell['kind'], refId: string) => inGrid.some((c) => c.kind === kind && c.refId === refId);
  const chats = sessions
    .filter((s) => !isArchived(s) && !s.taskId && !s.trainingRunId && !has('chat', s.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  const shells = terminals.filter((t) => !has('terminal', t.id) && !t.agentSessionId).slice(0, 6);
  const run = (fn: () => Promise<void>) => { setOpen(false); setBusy(true); void fn().finally(() => setBusy(false)); };

  return (
    <div
      ref={ref}
      className="absolute flex flex-col items-stretch rounded-2xl border border-dashed border-line"
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, transition }}
      data-grid-plus
    >
      <button
        className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        aria-expanded={open}
        aria-label="Add a window to the grid"
        title="Add an agent, a terminal, or an existing chat"
      >
        <span className="grid h-12 w-12 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><PlusIcon className="h-6 w-6" /></span>
        <span className="text-[12.5px] font-medium">{busy ? 'Starting…' : 'Add to the wall'}</span>
      </button>
      {open && (
        <div className="card absolute inset-x-3 top-3 z-30 max-h-[calc(100%-24px)] overflow-y-auto p-1.5 shadow-lg" style={{ background: 'var(--paper)' }} role="menu">
          <button className="create-row create-row-hero flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left" onClick={() => run(onNewChat)}>
            <span className="create-tile create-tile-brand"><ChatIcon className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">New agent</span>
              <span className="block text-[11px] text-ink-faint">A fresh chat, right here on the wall</span>
            </span>
            <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd>
          </button>
          <button className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left" onClick={() => run(onNewTerminal)}>
            <span className="create-tile" style={{ color: 'var(--success)' }}><TerminalIcon className="h-4 w-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">New terminal</span>
              <span className="block text-[11px] text-ink-faint">A shell in the active project</span>
            </span>
            <kbd className="kbd">{SHORTCUTS.newTerminal.label}</kbd>
          </button>
          {(chats.length > 0 || shells.length > 0) && (
            <>
              <p className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Already running</p>
              {chats.map((s) => (
                <button key={s.id} className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left" onClick={() => { setOpen(false); onAdd([{ kind: 'chat', refId: s.id }]); }}>
                  <ChatIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title}</span>
                  {s.parentSessionId && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
                </button>
              ))}
              {shells.map((t) => (
                <button key={t.id} className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left" onClick={() => { setOpen(false); onAdd([{ kind: 'terminal', refId: t.id }]); }}>
                  <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">{t.title}</span>
                  <span className="shrink-0 text-[11px]" style={{ color: t.running ? 'var(--success)' : 'var(--ink-faint)' }}>{t.running ? 'live' : 'exited'}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
