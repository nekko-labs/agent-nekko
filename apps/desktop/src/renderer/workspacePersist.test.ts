import { describe, expect, it } from 'vitest';
import type { Workspace } from './store.js';
import { removePane, type WbNode } from './layout.js';
import { loadLayout, maxIdSeq, pruneLayout, saveLayout } from './workspacePersist.js';

class MemStore {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

const chatWs = (id: string, extra?: WbNode): Workspace => {
  const pane: WbNode = { id: `pane_${id}`, kind: 'chat', refId: id };
  return {
    id: `ws_${id}`,
    anchor: { kind: 'chat', refId: id },
    root: extra ? { id: `split_${id}`, dir: 'row', children: [pane, extra], sizes: [0.5, 0.5] } : pane,
    activePaneId: extra ? extra.id : pane.id,
  };
};

describe('workspace layout persistence', () => {
  it('round-trips the open workspaces and the active one', () => {
    const store = new MemStore();
    const workspaces = [chatWs('a'), chatWs('b')];
    saveLayout({ workspaces, activeWorkspaceId: 'ws_a' }, store);
    expect(loadLayout(store)).toEqual({ workspaces, activeWorkspaceId: 'ws_a' });
  });

  it('reads garbage as an empty layout and drops malformed entries', () => {
    const store = new MemStore();
    store.setItem('nekko.workspaces.v1', '{nope');
    expect(loadLayout(store)).toEqual({ workspaces: [], activeWorkspaceId: null });
    store.setItem('nekko.workspaces.v1', JSON.stringify({ workspaces: [chatWs('a'), { id: 3 }], activeWorkspaceId: 'gone' }));
    const read = loadLayout(store);
    expect(read.workspaces.map((w) => w.id)).toEqual(['ws_a']);
    expect(read.activeWorkspaceId).toBe('ws_a');
  });

  it('finds the highest id suffix so new ids never collide with restored ones', () => {
    // ws_z / pane_z / split_z are 35; pane_1a is 46, the highest.
    expect(maxIdSeq([chatWs('z', { id: 'pane_1a', kind: 'terminal', refId: 't' })])).toBe(parseInt('1a', 36));
    expect(maxIdSeq([])).toBe(0);
  });

  it('prunes windows for gone chats and terminals, keeping untouched workspaces as they were', () => {
    const term: WbNode = { id: 'pane_t', kind: 'terminal', refId: 'term1' };
    const keep = chatWs('a');
    const withTerm = chatWs('b', term);
    const gone = chatWs('c');
    const out = pruneLayout([keep, withTerm, gone], new Set(['a', 'b']), new Set(), removePane);
    expect(out.map((w) => w.id)).toEqual(['ws_a', 'ws_b']);
    expect(out[0]).toBe(keep);
    expect(out[1].root).toMatchObject({ kind: 'chat', refId: 'b' });
    expect(out[1].activePaneId).toBe('pane_b');
  });

  it('leaves terminals alone until their list is known', () => {
    const ws = chatWs('b', { id: 'pane_t', kind: 'terminal', refId: 'term1' });
    expect(pruneLayout([ws], new Set(['b']), null, removePane)[0]).toBe(ws);
  });
});
