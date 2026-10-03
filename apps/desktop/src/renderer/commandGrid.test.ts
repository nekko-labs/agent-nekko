import { describe, expect, it } from 'vitest';
import type { SessionSummary, TerminalInfo } from '@agent-nekko/shared';
import {
  DEFAULT_GRID_STATE,
  autoShape,
  gridShape,
  layoutRects,
  loadGridState,
  reconcileGrid,
  resizeTracks,
  saveGridState,
  seedGrid,
  swapCells,
  tracksFor,
} from './commandGrid.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: id, createdAt: 1_000, updatedAt: 1_000, ...extra }) as unknown as SessionSummary;
const term = (id: string, running = true): TerminalInfo =>
  ({ id, title: id, cwd: '/', shell: 'sh', createdAt: 1_000, running }) as TerminalInfo;

describe('autoShape', () => {
  it('fills a wide area with squarish windows and the fewest empty places', () => {
    const wide = (n: number) => autoShape(n, 1800, 1000);
    expect(wide(1)).toEqual({ cols: 1, rows: 1 });
    expect(wide(2)).toEqual({ cols: 2, rows: 1 });
    expect(wide(3)).toEqual({ cols: 2, rows: 2 });
    expect(wide(4)).toEqual({ cols: 2, rows: 2 });
    expect(wide(5)).toEqual({ cols: 3, rows: 2 });
    expect(wide(7)).toEqual({ cols: 3, rows: 3 });
  });
  it('is one column on a phone', () => {
    expect(autoShape(5, 390, 800)).toEqual({ cols: 1, rows: 5 });
    expect(gridShape({ mode: 'fixed', cols: 3, rows: 2 }, 5, 390, 800)).toEqual({ cols: 1, rows: 5 });
  });
  it('keeps a fixed shape within the picker bounds', () => {
    expect(gridShape({ mode: 'fixed', cols: 9, rows: 0 }, 5, 1800, 1000)).toEqual({ cols: 6, rows: 1 });
  });
});

describe('tracks', () => {
  it('shares the space equally until a divider is dragged', () => {
    expect(tracksFor({}, 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(tracksFor({ '2': [0.7, 0.3] }, 2)).toEqual([0.7, 0.3]);
    // Stale or malformed saves are ignored.
    expect(tracksFor({ '2': [0.7] }, 2)).toEqual([0.5, 0.5]);
  });
  it('moves a divider between two tracks and stops at the minimum', () => {
    expect(resizeTracks([0.5, 0.5], 0, 0.1)).toEqual([0.6, 0.4]);
    expect(resizeTracks([0.5, 0.5], 0, -0.6)[0]).toBeCloseTo(0.12);
    expect(resizeTracks([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5]);
  });
  it('lays cells out left to right, top to bottom, and overflows into extra rows', () => {
    const { rects, totalHeight } = layoutRects(5, 2, 2, [0.5, 0.5], [0.5, 0.5], 1010, 610, 10);
    expect(rects[0]).toEqual({ x: 0, y: 0, width: 500, height: 300 });
    expect(rects[1]).toEqual({ x: 510, y: 0, width: 500, height: 300 });
    expect(rects[3]).toEqual({ x: 510, y: 310, width: 500, height: 300 });
    // The fifth cell starts a third row of the average height.
    expect(rects[4]).toEqual({ x: 0, y: 620, width: 500, height: 300 });
    expect(totalHeight).toBe(920);
  });
});

describe('grid contents', () => {
  it('seeds a fresh grid with recent top-level chats and running shells, then watermarks', () => {
    const now = 100 * 60 * 60_000;
    const sessions = [
      chat('old', { updatedAt: now - 48 * 60 * 60_000 }),
      chat('new', { updatedAt: now - 1000 }),
      chat('child', { updatedAt: now, parentSessionId: 'new' }),
      chat('done', { updatedAt: now, archivedAt: now }),
      chat('task', { updatedAt: now, taskId: 't1' }),
    ];
    const s = seedGrid(DEFAULT_GRID_STATE, sessions, [term('sh1'), term('sh2', false)], now);
    expect(s.cells).toEqual([{ kind: 'chat', refId: 'new' }, { kind: 'terminal', refId: 'sh1' }]);
    expect(s.watermark).toBe(now);
  });

  it('auto-adds chats created since the last look, sub-agents included, and drops archived ones', () => {
    const base = { ...DEFAULT_GRID_STATE, cells: [{ kind: 'chat' as const, refId: 'a' }, { kind: 'terminal' as const, refId: 'sh' }], watermark: 5_000 };
    const sessions = [chat('a', { createdAt: 1_000 }), chat('b', { createdAt: 6_000 }), chat('kid', { createdAt: 7_000, parentSessionId: 'b' })];
    const next = reconcileGrid(base, sessions, [term('sh')], 8_000);
    expect(next.cells.map((c) => c.refId)).toEqual(['a', 'sh', 'b', 'kid']);
    expect(next.watermark).toBe(7_000);
    // Nothing new: the very same object comes back, so no re-render or save.
    expect(reconcileGrid(next, sessions, [term('sh')], 9_000)).toBe(next);
    // Completing `a` and closing the shell takes both off the wall.
    const after = reconcileGrid(next, [chat('a', { createdAt: 1_000, archivedAt: 9_000 }), ...sessions.slice(1)], [], 9_000);
    expect(after.cells.map((c) => c.refId)).toEqual(['b', 'kid']);
  });

  it('respects the auto-add switch but still moves the watermark', () => {
    const base = { ...DEFAULT_GRID_STATE, autoAdd: false, watermark: 5_000 };
    const next = reconcileGrid(base, [chat('b', { createdAt: 6_000 })], [], 8_000);
    expect(next.cells).toEqual([]);
    expect(next.watermark).toBe(6_000);
  });

  it('swaps two cells', () => {
    const base = { ...DEFAULT_GRID_STATE, cells: [{ kind: 'chat' as const, refId: 'a' }, { kind: 'chat' as const, refId: 'b' }] };
    expect(swapCells(base, base.cells[0], base.cells[1]).cells.map((c) => c.refId)).toEqual(['b', 'a']);
  });

  it('round-trips through storage and shrugs off damage', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const state = { ...DEFAULT_GRID_STATE, layout: { mode: 'fixed' as const, cols: 3, rows: 2 }, filter: 'chat' as const, insights: { ...DEFAULT_GRID_STATE.insights, position: 'top' as const } };
    saveGridState(storage, state);
    expect(loadGridState(storage)).toEqual(state);
    store.set('nekko.commandGrid', '{"cells":[{"kind":"nope","refId":1}],"layout":{"mode":"fixed","cols":40,"rows":-1}}');
    expect(loadGridState(storage)).toMatchObject({ cells: [], layout: { mode: 'fixed', cols: 6, rows: 1 } });
    store.set('nekko.commandGrid', 'not json');
    expect(loadGridState(storage)).toEqual(DEFAULT_GRID_STATE);
  });
});
