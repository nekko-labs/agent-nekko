import { describe, it, expect } from 'vitest';
import {
  MAX_ACROSS,
  allPanes,
  canSplit,
  extent,
  isSplit,
  movePane,
  removePane,
  resizeSplit,
  splitPane,
  type Direction,
  type WbNode,
  type WbPane,
} from './layout.js';

const pane = (id: string): WbPane => ({ id, kind: 'chat', refId: id });

/** Ids of a split's children, so a shape assertion reads like the screen. */
const kids = (node: WbNode) => (isSplit(node) ? node.children.map((c) => (isSplit(c) ? c.dir : c.id)) : [node.id]);

/** Grow a tree by splitting the same pane over and over. */
function chain(dir: Direction, count: number): WbNode {
  let root: WbNode = pane('a');
  for (let i = 0; i < count; i++) root = splitPane(root, 'a', dir, pane(`p${i}`));
  return root;
}

describe('splitPane', () => {
  it('wraps a lone pane in a split of two', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(isSplit(root) && root.dir).toBe('row');
    expect(kids(root)).toEqual(['a', 'b']);
    expect(isSplit(root) && root.sizes).toEqual([0.5, 0.5]);
  });

  it('puts the new pane on the near side for up and left', () => {
    expect(kids(splitPane(pane('a'), 'a', 'left', pane('b')))).toEqual(['b', 'a']);
    const up = splitPane(pane('a'), 'a', 'up', pane('b'));
    expect(isSplit(up) && up.dir).toBe('col');
    expect(kids(up)).toEqual(['b', 'a']);
  });

  it('joins an existing split on the same axis instead of nesting', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    expect(kids(root)).toEqual(['a', 'b', 'c']);
    expect(isSplit(root) && root.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it('nests when the new pane crosses the axis it lands in', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    expect(kids(root)).toEqual(['a', 'col']);
    expect(isSplit(root) && kids(root.children[1])).toEqual(['b', 'c']);
  });

  it('splits a pane nested deep in the tree', () => {
    const nested = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    const root = splitPane(nested, 'c', 'down', pane('d'));
    expect(allPanes(root).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(extent(root)).toEqual({ across: 2, down: 3 });
  });

  it('leaves the tree alone when the target pane is gone', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(splitPane(root, 'nope', 'right', pane('c'))).toEqual(root);
  });
});

describe('extent and the 8×8 ceiling', () => {
  it('counts a row as wide and a column as tall', () => {
    expect(extent(chain('right', 3))).toEqual({ across: 4, down: 1 });
    expect(extent(chain('down', 3))).toEqual({ across: 1, down: 4 });
  });

  it('allows exactly eight across and refuses the ninth', () => {
    const full = chain('right', MAX_ACROSS - 1);
    expect(extent(full).across).toBe(MAX_ACROSS);
    expect(canSplit(full, 'a', 'right')).toBe(false);
    // The other axis is still free: a full row can always grow downwards.
    expect(canSplit(full, 'a', 'down')).toBe(true);
  });

  it('allows exactly eight down and refuses the ninth', () => {
    const full = chain('down', MAX_ACROSS - 1);
    expect(canSplit(full, 'a', 'down')).toBe(false);
    expect(canSplit(full, 'a', 'left')).toBe(true);
  });
});

describe('removePane', () => {
  it('collapses a split left with one child', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(removePane(root, 'b')).toEqual(pane('a'));
  });

  it('keeps the survivors and renormalizes their sizes', () => {
    const root = removePane(splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c')), 'b');
    expect(kids(root!)).toEqual(['a', 'c']);
    expect(isSplit(root!) && root.sizes.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });

  it('returns null when the last pane goes', () => {
    expect(removePane(pane('a'), 'a')).toBeNull();
  });

  it('unwinds nesting all the way back to a single pane', () => {
    let root: WbNode | null = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    root = removePane(root, 'c');
    root = removePane(root, 'b');
    expect(root).toEqual(pane('a'));
  });
});

describe('movePane', () => {
  it('drags a pane to the other side of the workspace', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    expect(kids(movePane(root, 'c', 'a', 'left')!)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when a pane is dropped on itself', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    expect(movePane(root, 'b', 'b', 'left')).toEqual(root);
  });

  it('leaves the layout alone when lifting the pane collapses the target away', () => {
    // Two panes: removing one leaves the other as the bare root, and dropping
    // beside it would be the same layout with extra churn.
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    const moved = movePane(root, 'b', 'a', 'left');
    expect(allPanes(moved).map((p) => p.id).sort()).toEqual(['a', 'b']);
  });

  it('does not count the dragged pane twice against the ceiling', () => {
    const full = chain('right', MAX_ACROSS - 1);
    const moved = movePane(full, 'p0', 'a', 'left');
    expect(extent(moved).across).toBe(MAX_ACROSS);
  });
});

describe('resizeSplit', () => {
  it('moves one divider and leaves the rest of the split alone', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    const resized = resizeSplit(root, root.id, 0, 0.6) as WbNode;
    const sizes = isSplit(resized) ? resized.sizes : [];
    [0.6, 0.15, 0.25].forEach((want, i) => expect(sizes[i]).toBeCloseTo(want));
  });

  it('stops the divider short of collapsing the pane after it', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'right', pane('c'));
    const resized = resizeSplit(root, root.id, 0, 0.95) as WbNode;
    // 'a' grows into 'b' only as far as the minimum allows, and 'c' is untouched.
    expect(isSplit(resized) && resized.sizes[1]).toBeGreaterThan(0.05);
    expect(isSplit(resized) && resized.sizes[2]).toBe(0.25);
  });

  it('never squeezes a pane below its minimum', () => {
    const root = splitPane(pane('a'), 'a', 'right', pane('b'));
    const squeezed = resizeSplit(root, root.id, 0, -5) as WbNode;
    expect(isSplit(squeezed) && squeezed.sizes[0]).toBeGreaterThan(0);
    expect(isSplit(squeezed) && squeezed.sizes[0] + squeezed.sizes[1]).toBeCloseTo(1);
  });

  it('resizes a nested split without touching its parent', () => {
    const root = splitPane(splitPane(pane('a'), 'a', 'right', pane('b')), 'b', 'down', pane('c'));
    const inner = isSplit(root) && isSplit(root.children[1]) ? root.children[1] : null;
    const resized = resizeSplit(root, inner!.id, 0, 0.3) as WbNode;
    expect(isSplit(resized) && resized.sizes).toEqual([0.5, 0.5]);
    expect(isSplit(resized) && isSplit(resized.children[1]) && resized.children[1].sizes).toEqual([0.3, 0.7]);
  });
});
