import type { SessionSummary, TerminalInfo } from '@agent-nekko/shared';
import { isArchived } from '@agent-nekko/shared';

/**
 * The Command Center grid: which live windows are on it, how they are laid
 * out, and what the toolbar switches are set to. Pure data and arithmetic,
 * so the view can be a thin layer and this can be tested on its own.
 *
 * The grid replaced a three-lane board of cards. A card could say what a chat
 * was doing; a cell *is* the chat (or the terminal), the same window the Agent
 * tab shows, so the operations wall is something you work in, not read.
 */

export type GridCellKind = 'chat' | 'terminal';

export interface GridCell {
  kind: GridCellKind;
  refId: string;
}

/** Auto picks a shape for the cells on hand; fixed is the user's own `cols × rows`. */
export type GridLayout = { mode: 'auto' } | { mode: 'fixed'; cols: number; rows: number };

export type GridFilter = 'all' | 'chat' | 'terminal';

export type InsightPanel = 'vitals' | 'optimize' | 'cost' | 'tokens' | 'models' | 'replies' | 'services';

export const INSIGHT_PANELS: Array<{ key: InsightPanel; label: string; blurb: string }> = [
  { key: 'vitals', label: 'Vitals', blurb: 'Agents working, waiting on you, automations, terminals, tokens and spend' },
  { key: 'optimize', label: 'Optimize tips', blurb: 'Ways to cut token spend, from your own usage' },
  { key: 'cost', label: 'Cost', blurb: 'This month, the projection, daily spend and the top agents' },
  { key: 'tokens', label: 'Tokens over time', blurb: 'Input and output tokens, day by day' },
  { key: 'models', label: 'By model', blurb: 'Tokens and cost per model' },
  { key: 'replies', label: 'Replies', blurb: 'How replies end and how many tool steps they take' },
  { key: 'services', label: 'Services', blurb: 'Providers, MCP servers and the remote relay, with live status' },
];

export interface InsightsPrefs {
  show: boolean;
  position: 'top' | 'bottom';
  panels: Record<InsightPanel, boolean>;
}

export interface CommandGridState {
  cells: GridCell[];
  layout: GridLayout;
  /** New chats (including spawned sub-agents) join the grid as they appear. */
  autoAdd: boolean;
  filter: GridFilter;
  /** Column widths as fractions of the grid, keyed by how many columns there are. */
  colSizes: Record<string, number[]>;
  /** Row heights as fractions of the grid, keyed by how many rows there are. */
  rowSizes: Record<string, number[]>;
  insights: InsightsPrefs;
  /** Chats created after this moment are auto-added; 0 until the grid has been seeded once. */
  watermark: number;
}

/** The most columns or rows the fixed picker offers. */
export const GRID_MAX = 6;
/** No track shrinks below this share of the grid, so a window can always be used. */
export const MIN_TRACK = 0.12;
/** Space between cells, in pixels. */
export const GRID_GAP = 10;
/** Below this width the grid is one column: a phone, or a very narrow window. */
export const NARROW_WIDTH = 720;
/** Chats seeded onto a fresh grid: the ones touched in the last day, newest first, this many at most. */
const SEED_CHATS = 8;
const SEED_TERMINALS = 4;
const DAY = 24 * 60 * 60_000;

export const DEFAULT_INSIGHTS: InsightsPrefs = {
  show: true,
  position: 'bottom',
  panels: { vitals: true, optimize: true, cost: true, tokens: true, models: false, replies: false, services: false },
};

export const DEFAULT_GRID_STATE: CommandGridState = {
  cells: [],
  layout: { mode: 'auto' },
  autoAdd: true,
  filter: 'all',
  colSizes: {},
  rowSizes: {},
  insights: DEFAULT_INSIGHTS,
  watermark: 0,
};

export const GRID_STATE_KEY = 'nekko.commandGrid';

export const sameCell = (a: GridCell, b: GridCell): boolean => a.kind === b.kind && a.refId === b.refId;

/**
 * The shape auto mode picks for `count` cells in a `width × height` area:
 * the column count whose cells come closest to a comfortable window (a bit
 * wider than tall) while leaving the fewest empty places. Two cells sit side
 * by side, four make a square, five fill three by two, and so on.
 */
export function autoShape(count: number, width: number, height: number): { cols: number; rows: number } {
  const n = Math.max(1, count);
  if (width > 0 && width < NARROW_WIDTH) return { cols: 1, rows: n };
  const aspect = width > 0 && height > 0 ? width / height : 1.7;
  let best = { cols: 1, rows: n, score: Infinity };
  for (let cols = 1; cols <= Math.min(GRID_MAX, n); cols++) {
    const rows = Math.ceil(n / cols);
    const cellAspect = (aspect * rows) / cols;
    const score = Math.abs(Math.log(cellAspect / 1.4)) + (0.35 * (cols * rows - n)) / n;
    if (score < best.score - 1e-9) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

/** The shape the grid draws: the user's fixed one, or auto's, one column when narrow. */
export function gridShape(layout: GridLayout, count: number, width: number, height: number): { cols: number; rows: number } {
  if (width > 0 && width < NARROW_WIDTH) return { cols: 1, rows: Math.max(1, count) };
  if (layout.mode === 'fixed') return { cols: clampTracks(layout.cols), rows: clampTracks(layout.rows) };
  return autoShape(count, width, height);
}

export function clampTracks(n: number): number {
  return Math.min(GRID_MAX, Math.max(1, Math.round(n) || 1));
}

/** Saved track fractions for `n` tracks, else `n` equal shares. */
export function tracksFor(sizes: Record<string, number[]>, n: number): number[] {
  const saved = sizes[String(n)];
  if (saved && saved.length === n && saved.every((f) => Number.isFinite(f) && f > 0)) return normalize(saved);
  return Array.from({ length: n }, () => 1 / n);
}

function normalize(fr: number[]): number[] {
  const sum = fr.reduce((s, f) => s + f, 0) || 1;
  return fr.map((f) => f / sum);
}

/**
 * Drag the divider after track `index` by `delta` (a fraction of the whole):
 * that track grows and its neighbour shrinks by the same amount, neither
 * below the minimum, so the rest of the grid stays where it was.
 */
export function resizeTracks(fr: number[], index: number, delta: number): number[] {
  if (index < 0 || index >= fr.length - 1) return fr;
  const a = fr[index], b = fr[index + 1];
  const room = Math.max(0, delta > 0 ? b - MIN_TRACK : a - MIN_TRACK);
  const d = Math.sign(delta) * Math.min(Math.abs(delta), room);
  if (d === 0) return fr;
  const next = [...fr];
  next[index] = a + d;
  next[index + 1] = b - d;
  return next;
}

export interface CellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where each of `count` cells goes, reading left to right and top to bottom,
 * in a grid of `cols` columns whose first `rows` rows share `height`. Cells
 * past that many rows take rows of the average height below, so a fixed
 * `3 × 2` with nine windows is three rows tall and scrolls.
 */
export function layoutRects(count: number, cols: number, rows: number, colFr: number[], rowFr: number[], width: number, height: number, gap = GRID_GAP): { rects: CellRect[]; totalHeight: number } {
  const innerW = Math.max(0, width - gap * (cols - 1));
  const innerH = Math.max(0, height - gap * (rows - 1));
  const colW = colFr.map((f) => f * innerW);
  const baseRowH = rowFr.map((f) => f * innerH);
  const neededRows = Math.max(rows, Math.ceil(count / cols));
  const extraH = innerH / rows;
  const rowH = Array.from({ length: neededRows }, (_, r) => (r < rows ? baseRowH[r] : extraH));
  const colX: number[] = [];
  const rowY: number[] = [];
  let x = 0;
  for (let c = 0; c < cols; c++) { colX.push(x); x += colW[c] + gap; }
  let y = 0;
  for (let r = 0; r < neededRows; r++) { rowY.push(y); y += rowH[r] + gap; }
  const rects: CellRect[] = [];
  for (let i = 0; i < count; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    rects.push({ x: colX[c], y: rowY[r], width: colW[c], height: rowH[r] });
  }
  return { rects, totalHeight: Math.max(0, y - gap) };
}

/** The cells the filter lets through, in grid order. */
export function visibleCells(cells: GridCell[], filter: GridFilter): GridCell[] {
  return filter === 'all' ? cells : cells.filter((c) => c.kind === filter);
}

export function addCells(state: CommandGridState, add: GridCell[]): CommandGridState {
  const fresh = add.filter((c, i) => !state.cells.some((x) => sameCell(x, c)) && add.findIndex((y) => sameCell(y, c)) === i);
  return fresh.length ? { ...state, cells: [...state.cells, ...fresh] } : state;
}

export function removeCell(state: CommandGridState, cell: GridCell): CommandGridState {
  const cells = state.cells.filter((c) => !sameCell(c, cell));
  return cells.length === state.cells.length ? state : { ...state, cells };
}

/** Trade two cells' places (a drag of one window's strip onto another). */
export function swapCells(state: CommandGridState, a: GridCell, b: GridCell): CommandGridState {
  const i = state.cells.findIndex((c) => sameCell(c, a));
  const j = state.cells.findIndex((c) => sameCell(c, b));
  if (i < 0 || j < 0 || i === j) return state;
  const cells = [...state.cells];
  [cells[i], cells[j]] = [cells[j], cells[i]];
  return { ...state, cells };
}

/** A chat the grid can show: a real conversation, not archived, not a task's or training run's. */
function gridChat(s: SessionSummary): boolean {
  return !isArchived(s) && !s.taskId && !s.trainingRunId;
}

/**
 * What a grid that has never been used starts with: the chats touched in the
 * last day (newest first) and the shells still running. The watermark is set
 * so only chats created from now on are added automatically.
 */
export function seedGrid(state: CommandGridState, sessions: SessionSummary[], terminals: TerminalInfo[], now: number): CommandGridState {
  const chats = sessions
    .filter((s) => gridChat(s) && !s.parentSessionId && now - s.updatedAt < DAY)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SEED_CHATS)
    .map((s): GridCell => ({ kind: 'chat', refId: s.id }));
  const shells = terminals
    .filter((t) => t.running && !t.agentSessionId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, SEED_TERMINALS)
    .map((t): GridCell => ({ kind: 'terminal', refId: t.id }));
  return { ...addCells(state, [...chats, ...shells]), watermark: now };
}

/**
 * Keep the grid honest against what exists: drop cells whose chat is gone or
 * archived (completing a chat takes it off the wall) and whose terminal is
 * gone, and, when auto-add is on, add every chat created since the last look,
 * spawned sub-agents included. Returns the same object when nothing changed.
 */
export function reconcileGrid(state: CommandGridState, sessions: SessionSummary[], terminals: TerminalInfo[], now: number): CommandGridState {
  // Seed once, and only once the lists have arrived: the view mounts with
  // empty lists, and seeding against those would watermark every chat that
  // already exists out of the grid.
  if (state.watermark === 0) return sessions.length === 0 && terminals.length === 0 ? state : seedGrid(state, sessions, terminals, now);
  const chatById = new Map(sessions.map((s) => [s.id, s]));
  const termIds = new Set(terminals.map((t) => t.id));
  const kept = state.cells.filter((c) => (c.kind === 'chat' ? !!chatById.get(c.refId) && gridChat(chatById.get(c.refId)!) : termIds.has(c.refId)));
  let next: CommandGridState = kept.length === state.cells.length ? state : { ...state, cells: kept };
  let watermark = state.watermark;
  const added: GridCell[] = [];
  for (const s of sessions) {
    if (s.createdAt > state.watermark && state.autoAdd && gridChat(s)) added.push({ kind: 'chat', refId: s.id });
    watermark = Math.max(watermark, s.createdAt);
  }
  if (added.length) next = addCells(next, added);
  if (watermark !== state.watermark) next = { ...next, watermark };
  return next;
}

/** Read the saved grid, tolerating a missing or damaged entry. */
export function loadGridState(storage: Pick<Storage, 'getItem'> | undefined): CommandGridState {
  try {
    const raw = storage?.getItem(GRID_STATE_KEY);
    if (!raw) return DEFAULT_GRID_STATE;
    const saved = JSON.parse(raw) as Partial<CommandGridState>;
    const cells = Array.isArray(saved.cells)
      ? saved.cells.filter((c): c is GridCell => !!c && (c.kind === 'chat' || c.kind === 'terminal') && typeof c.refId === 'string')
      : [];
    const layout: GridLayout =
      saved.layout?.mode === 'fixed' ? { mode: 'fixed', cols: clampTracks(saved.layout.cols), rows: clampTracks(saved.layout.rows) } : { mode: 'auto' };
    const insights: InsightsPrefs = {
      show: saved.insights?.show ?? DEFAULT_INSIGHTS.show,
      position: saved.insights?.position === 'top' ? 'top' : 'bottom',
      panels: { ...DEFAULT_INSIGHTS.panels, ...(saved.insights?.panels ?? {}) },
    };
    return {
      cells,
      layout,
      autoAdd: saved.autoAdd ?? true,
      filter: saved.filter === 'chat' || saved.filter === 'terminal' ? saved.filter : 'all',
      colSizes: saved.colSizes && typeof saved.colSizes === 'object' ? saved.colSizes : {},
      rowSizes: saved.rowSizes && typeof saved.rowSizes === 'object' ? saved.rowSizes : {},
      insights,
      watermark: typeof saved.watermark === 'number' ? saved.watermark : 0,
    };
  } catch {
    return DEFAULT_GRID_STATE;
  }
}

export function saveGridState(storage: Pick<Storage, 'setItem'> | undefined, state: CommandGridState): void {
  try {
    storage?.setItem(GRID_STATE_KEY, JSON.stringify(state));
  } catch {
    /* private mode or full */
  }
}
