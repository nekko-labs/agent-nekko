import { describe, expect, it } from 'vitest';
import type { SessionSummary, TerminalInfo } from '@agent-nekko/shared';
import { allPanes, extent, isSplit, type WbPane } from './layout.js';
import {
  DEFAULT_WALL_STATE,
  LEGACY_GRID_KEY,
  WALL_STATE_KEY,
  addPane,
  autoShape,
  filterTree,
  leafRects,
  loadWallState,
  migrateGridState,
  reconcileWall,
  saveWallState,
  seedWall,
  tileTree,
  wallPane,
} from './commandWall.js';

const chat = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, title: id, createdAt: 1_000, updatedAt: 1_000, ...extra }) as unknown as SessionSummary;
const term = (id: string, running = true): TerminalInfo =>
  ({ id, title: id, cwd: '/', shell: 'sh', createdAt: 1_000, running }) as TerminalInfo;
const panes = (n: number): WbPane[] => Array.from({ length: n }, (_, i) => wallPane('chat', `c${i}`));
const refs = (root: ReturnType<typeof tileTree>) => allPanes(root).map((p) => p.refId);

describe('autoShape', () => {
  it('fills a wide area with squarish windows and the fewest empty places', () => {
    const wide = (n: number) => autoShape(n, 1.8);
    expect(wide(1)).toEqual({ cols: 1, rows: 1 });
    expect(wide(2)).toEqual({ cols: 2, rows: 1 });
    expect(wide(3)).toEqual({ cols: 2, rows: 2 });
    expect(wide(4)).toEqual({ cols: 2, rows: 2 });
    expect(wide(5)).toEqual({ cols: 3, rows: 2 });
    expect(wide(7)).toEqual({ cols: 3, rows: 3 });
  });
});

describe('tileTree', () => {
  it('is nothing for no windows and the window itself for one', () => {
    expect(tileTree([])).toBeNull();
    const [only] = panes(1);
    expect(tileTree([only])).toBe(only);
  });
  it('tiles five windows as a row of three over a row of two, in reading order', () => {
    const root = tileTree(panes(5), 1.8);
    expect(root && isSplit(root) && root.dir).toBe('col');
    expect(extent(root)).toEqual({ across: 3, down: 2 });
    expect(refs(root)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
  });
  it('shares each row equally', () => {
    const root = tileTree(panes(4), 1.8);
    const rects = leafRects(root);
    for (const r of rects.values()) {
      expect(r.width).toBeCloseTo(0.5);
      expect(r.height).toBeCloseTo(0.5);
    }
  });
});

describe('addPane', () => {
  it('starts a wall with the window itself', () => {
    const [a] = panes(1);
    expect(addPane(null, a)).toBe(a);
  });
  it('lands beside the biggest window, along its longer side', () => {
    const [a, b, c] = panes(3);
    // One wide window: the second goes to its right.
    let root = addPane(a, b, 1.8);
    expect(root && isSplit(root) && root.dir).toBe('row');
    // Two half-width windows are taller than wide: the third goes below the first.
    root = addPane(root, c, 1.8);
    expect(extent(root)).toEqual({ across: 2, down: 2 });
    const rects = leafRects(root);
    expect(rects.get(c.id)!.y).toBeGreaterThan(0);
  });
  it('never breaks the 8×8 ceiling', () => {
    let root = tileTree(panes(1), 1.8);
    for (let i = 1; i < 80; i++) root = addPane(root, wallPane('chat', `x${i}`), 1.8);
    const { across, down } = extent(root);
    expect(across).toBeLessThanOrEqual(8);
    expect(down).toBeLessThanOrEqual(8);
  });
});

describe('filterTree', () => {
  it('lifts out the other kind and keeps the panels', () => {
    const root = tileTree([wallPane('chat', 'a'), wallPane('terminal', 't'), wallPane('automations'), wallPane('insights')], 1.8);
    expect(refs(filterTree(root, 'all'))).toEqual(['a', 't', 'automations', 'insights']);
    expect(refs(filterTree(root, 'chat'))).toEqual(['a', 'automations', 'insights']);
    expect(refs(filterTree(root, 'terminal'))).toEqual(['t', 'automations', 'insights']);
  });
});

describe('seedWall', () => {
  it('starts with the chats touched in the last day and the shells still running, with the panels beside them', () => {
    const now = 100 * 60 * 60_000;
    const seeded = seedWall(
      DEFAULT_WALL_STATE,
      [chat('fresh', { updatedAt: now - 1000 }), chat('stale', { updatedAt: now - 48 * 60 * 60_000 }), chat('child', { updatedAt: now, parentSessionId: 'fresh' } as Partial<SessionSummary>)],
      [term('live'), term('dead', false)],
      now,
    );
    const kinds = allPanes(seeded.root).map((p) => `${p.kind}:${p.refId}`);
    expect(kinds).toEqual(['chat:fresh', 'terminal:live', 'automations:automations', 'insights:insights']);
    expect(seeded.watermark).toBe(now);
  });
});

describe('reconcileWall', () => {
  const now = 10_000;
  const seeded = seedWall(DEFAULT_WALL_STATE, [chat('a', { updatedAt: now })], [], now);

  it('waits for the lists before seeding, then seeds once', () => {
    expect(reconcileWall(DEFAULT_WALL_STATE, [], [], now)).toBe(DEFAULT_WALL_STATE);
    expect(reconcileWall(DEFAULT_WALL_STATE, [chat('a', { updatedAt: now })], [], now).watermark).toBe(now);
  });
  it('drops a chat that is gone or archived and adds one created since', () => {
    const next = reconcileWall(seeded, [chat('a', { archivedAt: 5 } as Partial<SessionSummary>), chat('b', { createdAt: now + 1 })], [], now + 5);
    const kinds = allPanes(next.root).map((p) => `${p.kind}:${p.refId}`);
    expect(kinds).not.toContain('chat:a');
    expect(kinds).toContain('chat:b');
    expect(next.watermark).toBe(now + 1);
  });
  it('does not add new chats while auto-add is off, but still moves the watermark', () => {
    const next = reconcileWall({ ...seeded, autoAdd: false }, [chat('a', { updatedAt: now }), chat('b', { createdAt: now + 1 })], [], now + 5);
    expect(allPanes(next.root).map((p) => p.refId)).not.toContain('b');
    expect(next.watermark).toBe(now + 1);
  });
  it('returns the same object when nothing changed', () => {
    expect(reconcileWall(seeded, [chat('a', { updatedAt: now })], [], now + 5)).toBe(seeded);
  });
});

describe('persistence', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('round-trips a wall and never mints a restored id again', () => {
    const storage = memory();
    const state = seedWall(DEFAULT_WALL_STATE, [chat('a', { updatedAt: 1 }), chat('b', { updatedAt: 1 })], [], 1);
    saveWallState(storage, state);
    const loaded = loadWallState(storage);
    expect(loaded.root).toEqual(state.root);
    const fresh = wallPane('chat', 'z');
    expect(allPanes(loaded.root).some((p) => p.id === fresh.id)).toBe(false);
  });
  it('carries the previous grid over as a tiled wall with the panels beside it', () => {
    const storage = memory();
    storage.setItem(LEGACY_GRID_KEY, JSON.stringify({ cells: [{ kind: 'chat', refId: 'a' }, { kind: 'terminal', refId: 't' }], autoAdd: false, filter: 'chat', insights: { show: true, panels: { models: true } }, watermark: 77 }));
    const loaded = loadWallState(storage);
    expect(allPanes(loaded.root).map((p) => `${p.kind}:${p.refId}`)).toEqual(['chat:a', 'terminal:t', 'automations:automations', 'insights:insights']);
    expect(loaded.autoAdd).toBe(false);
    expect(loaded.filter).toBe('chat');
    expect(loaded.insights.panels.models).toBe(true);
    expect(loaded.watermark).toBe(77);
  });
  it('leaves the panels out when the grid had hidden its insights box', () => {
    const migrated = migrateGridState({ cells: [{ kind: 'chat', refId: 'a' }], insights: { show: false } });
    expect(allPanes(migrated!.root).map((p) => p.kind)).toEqual(['chat']);
  });
  it('tolerates a damaged entry and an unknown kind', () => {
    const storage = memory();
    storage.setItem(WALL_STATE_KEY, '{nope');
    expect(loadWallState(storage)).toEqual(DEFAULT_WALL_STATE);
    storage.setItem(WALL_STATE_KEY, JSON.stringify({ root: { id: 'split_1', dir: 'row', children: [{ id: 'pane_2', kind: 'browser', refId: 'x' }, { id: 'pane_3', kind: 'chat', refId: 'a' }], sizes: [0.5, 0.5] } }));
    const loaded = loadWallState(storage);
    expect(allPanes(loaded.root).map((p) => p.refId)).toEqual(['a']);
  });
});
