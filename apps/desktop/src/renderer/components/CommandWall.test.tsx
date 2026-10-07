import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE, type CommandWallState } from '../commandWall.js';
import { type WbPane, type WbSplit } from '../layout.js';
import type { Workspace } from '../store.js';

const fixture = vi.hoisted(() => ({ workspaces: [] as Workspace[] }));
vi.mock('../store.js', () => ({ useStore: (select: (s: { workspaces: Workspace[] }) => unknown) => select(fixture) }));
vi.mock('./ChatPane.js', () => ({ ChatPane: ({ sessionId, surface }: { sessionId: string; surface: string }) => <textarea data-surface={surface} defaultValue={`draft:${sessionId}`} /> }));
vi.mock('./TerminalPane.js', () => ({ TerminalPane: ({ terminalId }: { terminalId: string }) => <div data-terminal={terminalId} /> }));
vi.mock('./FilePane.js', () => ({ FilePane: ({ path }: { path: string }) => <div data-file={path} /> }));
vi.mock('./ExplorerPane.js', () => ({ ExplorerPane: ({ paneId }: { paneId: string }) => <div data-explorer={paneId} /> }));
vi.mock('./BrowserPane.js', () => ({ BrowserPane: ({ url }: { url: string }) => <div data-browser={url} /> }));
vi.mock('./DiffPane.js', () => ({ DiffPane: ({ sessionId }: { sessionId: string }) => <div data-diff={sessionId} /> }));
vi.mock('./PaneFrame.js', () => ({
  PaneFrame: ({ title, children }: { title: string; children: React.ReactNode }) => <section data-title={title}>{children}</section>,
  PaneActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
import { CommandWall, commandWallGeometry, companionTree, resizeCompanionSplit, workspaceCompanions } from './CommandWall.js';
import { leafRects } from '../commandWall.js';

const a: WbPane = { id: 'a', kind: 'chat', refId: 'chat-a' };
const b: WbPane = { id: 'b', kind: 'chat', refId: 'chat-b' };
const t: WbPane = { id: 't', kind: 'terminal', refId: 'term' };
const root: WbSplit = { id: 'split', dir: 'row', children: [a, b, t], sizes: [0.5, 0.3, 0.2] };
const state = (patch: Partial<CommandWallState> = {}): CommandWallState => ({ ...DEFAULT_WALL_STATE, root, layout: { mode: 'grid', cols: 3, rows: 2 }, folded: {}, ...patch });
const layout = (mode: 'grid' | 'focus' | 'fixed') => ({ mode, cols: 2, rows: 1 });

function wall(s: CommandWallState, addContent?: React.ReactNode) {
  return <CommandWall state={s} setState={vi.fn()} sessions={[]} terminals={[]} running={new Set()} pending={{}} childrenOf={new Map()} projects={[]} flash={null} selectedId={null} onSelect={vi.fn()} onAspect={vi.fn()} onOpenChat={vi.fn()} onOpenTerminal={vi.fn()} onNewChat={vi.fn()} onNewTerminal={vi.fn()} onAddWindow={vi.fn()} addContent={addContent} />;
}

describe('command wall geometry', () => {
  it('nests creation details inside the Add tile without a pane-stage offset', () => {
    const html = renderToStaticMarkup(wall(state(), <div>New chat details</div>));
    expect(html).toMatch(/command-wall-add-tile[^]*?wall-window-picker[^]*?New chat details[^]*?<\/section>/);
    expect(html).not.toContain('top:80px');
  });
  it.each(['grid', 'fixed'] as const)('fits %s windows into the space remaining above the composer', (mode) => {
    const before = JSON.stringify(root);
    const g = commandWallGeometry(state({ layout: { mode, cols: 3, rows: 2 } }), 2400, 600);
    expect(g.stageHeight).toBeLessThanOrEqual(600);
    for (const pane of g.panes.values()) expect(pane.y + pane.height).toBeLessThanOrEqual(600);
    expect(JSON.stringify(root)).toBe(before);
  });
  it('converts an expanded divider resize back to saved ratios without cumulative widening', () => {
    const expanded = new Set(['a']);
    const resized = resizeCompanionSplit(root, expanded, 'split', 0, .6) as WbSplit;
    const displayed = companionTree(resized, expanded) as WbSplit;
    expect(displayed.sizes[0]).toBeCloseTo(.6);
    expect(displayed.sizes[2]).toBeCloseTo((companionTree(root, expanded) as WbSplit).sizes[2]);
    expect(companionTree(displayed, expanded, 1 / 1.9)).toEqual(resized);
    expect(root.sizes).toEqual([.5, .3, .2]);
  });
  it('keeps the Add preview separate from every existing window', () => {
    const g = commandWallGeometry(state(), 1000, 700, new Set(['a']));
    for (const pane of g.panes.values()) {
      const overlapWidth = Math.min(pane.x + pane.width, g.add.x + g.add.width) - Math.max(pane.x, g.add.x);
      const overlapHeight = Math.min(pane.y + pane.height, g.add.y + g.add.height) - Math.max(pane.y, g.add.y);
      expect(overlapWidth > 0 && overlapHeight > 0).toBe(false);
    }
  });
  it('widens companion leaves without changing saved ratios', () => {
    const before = JSON.stringify(root);
    const widened = companionTree(root, new Set(['a'])) as WbSplit;
    expect(widened.sizes[0] / widened.sizes[1]).toBeCloseTo((0.5 * 1.9) / 0.3);
    expect(JSON.stringify(root)).toBe(before);
  });

  it('does not duplicate shared companions under a secondary chat', () => {
    const shared = { ...workspace, root: { ...root, children: [a, b, ...companions], sizes: Array(7).fill(1 / 7) } };
    expect(workspaceCompanions([shared], 'chat-b')).toEqual([]);
    expect(workspaceCompanions([shared], 'chat-a')).toHaveLength(4);
  });
  it('keeps narrow Focus transcripts and approval controls above stacked companions', () => {
    const g = commandWallGeometry(state({ layout: layout('focus'), hero: 'chat-a' }), 390, 300);
    expect(g.panes.get('a')!.height).toBe(960);
    expect(g.height).toBe(960);
    expect(g.panes.get('a')!.height * .65).toBeGreaterThan(600);
  });

  it('retains saved Grid ratios and split identities without mutating the source tree', () => {
    const s = state();
    const before = JSON.stringify(s);
    const g = commandWallGeometry(s, 1000, 700);
    expect(g.panes.get('a')).toEqual({ x: 0, y: 0, width: 496, height: 664 });
    expect(g.panes.get('b')).toEqual({ x: 504, y: 0, width: 292, height: 664 });
    expect(g.panes.get('t')).toEqual({ x: 804, y: 0, width: 196, height: 664 });
    expect(g.addGrid!.id).toBe(root.id);
    expect(g.deck.size).toBe(0);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('ignores companion folding in every mode, including Focus hero selection', () => {
    for (const mode of ['grid', 'fixed', 'focus'] as const) {
      const s = state({ layout: layout(mode), hero: 'chat-a' });
      const g = commandWallGeometry(s, 1000, 700);
      const folded = commandWallGeometry({ ...s, folded: { 'chat-a': true, 'chat-b': true, term: true } }, 1000, 700);
      expect(folded.panes).toEqual(g.panes);
      expect(folded.deck).toEqual(g.deck);
      expect(folded.hero).toEqual(g.hero);
      expect(folded.add).toEqual(g.add);
      expect(g.deck.size).toBe(mode === 'focus' ? 2 : 0);
    }
  });

  it.each([[1000, 700], [2400, 400], [390, 700]])('keeps Add compact until preview at %i × %i', (width, height) => {
    const before = JSON.stringify(root);
    const idle = commandWallGeometry(state(), width, height);
    const preview = commandWallGeometry(state(), width, height, new Set(), true);
    expect(idle.add.height).toBe(28);
    expect(preview.add.height).toBeGreaterThan(28);
    expect(preview.panes.has('__wall_add__')).toBe(false);
    expect(JSON.stringify(root)).toBe(before);
    for (const pane of preview.panes.values()) {
      const overlapWidth = Math.min(pane.x + pane.width, preview.add.x + preview.add.width) - Math.max(pane.x, preview.add.x);
      const overlapHeight = Math.min(pane.y + pane.height, preview.add.y + preview.add.height) - Math.max(pane.y, preview.add.y);
      expect(overlapWidth > 0 && overlapHeight > 0).toBe(false);
    }
  });

  it('displays a saved divider edit instead of re-balancing it on render', () => {
    const resized = resizeCompanionSplit(root, new Set(), root.id, 0, .6);
    const g = commandWallGeometry(state({ root: resized }), 1000, 700);
    expect(g.panes.get('a')!.width).toBe(596);
    expect(g.panes.get('b')!.x).toBe(604);
    expect(g.panes.get('b')!.width).toBeCloseTo(192);
    expect(g.addGrid!.id).toBe(root.id);
  });

  it('does not reserve a full Add card in a short viewport', () => {
    const g = commandWallGeometry(state(), 1000, 480);
    expect(g.height).toBe(g.add.y + g.add.height);
    expect(g.height).toBe(480);
  });

  it('uses Focus-only deck and falls back when the hero is missing or filtered', () => {
    const g = commandWallGeometry(state({ layout: layout('focus'), hero: 'chat-b' }), 1000, 700);
    expect(g.hero).toBe('b');
    expect(g.panes.get('b')).toEqual({ x: 0, y: 0, width: 1000, height: 700 });
    expect([...g.deck]).toEqual(['a', 't']);
    expect(g.add.x).toBe(0);
    expect(g.add.width).toBeLessThanOrEqual(1000);
    expect(g.add.height).toBe(240);
    expect(commandWallGeometry(state({ layout: layout('focus'), hero: 'missing' }), 1000, 700).hero).toBe('a');
    expect(commandWallGeometry(state({ layout: layout('focus'), filter: 'terminal' }), 1000, 700).hero).toBe('t');
  });

  it('keeps Fixed overflow and Add reachable without a deck', () => {
    const g = commandWallGeometry(state({ layout: layout('fixed') }), 1000, 700);
    expect(g.add).toEqual({ x: 0, y: 1344, width: 1000, height: 28 });
    expect(g.height).toBe(1372);
    expect(g.deck.size).toBe(0);
  });

  it('stacks narrow Grid and Fixed panes and handles unmeasured empty mounts', () => {
    for (const mode of ['grid', 'fixed'] as const) {
      const g = commandWallGeometry(state({ layout: layout(mode) }), 400, 700);
      expect(g.panes.get('a')!.height).toBe(440);
      expect(g.add.y).toBe(1344);
    }
    for (const mode of ['grid', 'fixed', 'focus'] as const) {
      const g = commandWallGeometry(state({ root: null, layout: layout(mode) }), 0, 0);
      expect(g.panes.size).toBe(0);
      for (const n of Object.values(g.add)) expect(Number.isFinite(n) && n >= 0).toBe(true);
    }
  });
});

const companions: WbPane[] = [
  { id: 'file', kind: 'file', refId: '/source.ts' },
  { id: 'files', kind: 'files', refId: '/project' },
  { id: 'browser', kind: 'browser', refId: 'https://example.com' },
  { id: 'diff', kind: 'diff', refId: 'chat-a' },
  { id: 'other-diff', kind: 'diff', refId: 'chat-b' },
];
const workspace: Workspace = { id: 'workspace', anchor: { kind: 'chat', refId: 'chat-a' }, activePaneId: 'a', root: { ...root, children: [a, ...companions], sizes: Array(6).fill(1 / 6) } };

describe('workspace companions and stable bodies', () => {
  it('reads the anchored workspace or containing layout without copying pane records', () => {
    expect(workspaceCompanions([workspace], 'chat-a')).toEqual(companions.slice(0, 4));
    expect(workspaceCompanions([workspace], 'chat-a')[0]).toBe(companions[0]);
    expect(workspaceCompanions([{ ...workspace, anchor: { kind: 'terminal', refId: 'term' } }], 'chat-a')).toEqual(companions.slice(0, 4));
    expect(workspaceCompanions([workspace], 'missing')).toEqual([]);
  });

  it('counts companions, has no whole-chat collapse control, and keeps all bodies mounted', () => {
    fixture.workspaces = [workspace];
    try {
      const html = renderToStaticMarkup(wall(state({ folded: { 'chat-a': true }, filter: 'chat' })));
      expect(html).toContain('aria-label="Expand companions for Chat (4)"');
      expect(html).not.toContain('Collapse Chat');
      expect(html).not.toContain('command-wall-folded');
      expect(html).toContain('draft:chat-a');
      expect(html).toContain('draft:chat-b');
      expect(html).toContain('data-terminal="term"');
      expect(html).toContain('data-explorer="files"');
      expect(html).toContain('data-browser="https://example.com"');
      expect(html).toContain('data-diff="chat-a"');
      expect(html).toContain('aria-label="Add window"');
      expect(html).toContain('aria-label="Focus Chat"');
      expect(html).toContain('aria-label="Open Chat in the Agent tab"');
    } finally { fixture.workspaces = []; }
  });

  it('keeps keyed bodies under one parent and preserves reduced-motion support', () => {
    const source = readFileSync(new URL('./CommandWall.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./commandWallLayouts.css', import.meta.url), 'utf8');
    expect(source).toContain('{allPanes(state.root).map(renderLeaf)}');
    expect(source).toContain('key={pane.id}');
    expect(source).toContain('key={companion.id}');
    expect(source).toContain("surface={focusedChat ? 'full' : 'transcript'}");
    expect(source).toContain('useStore.getState().closePane(companion.id)');
    expect(source).not.toContain('inert={folded');
    expect(css).toContain('transition: left 260ms ease');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.command-wall-window, .command-wall-add { transition: none; }');
    expect(source).toContain("matches ? 'auto' : 'smooth'");
  });
});

describe('click-only wall insertion and composer framing', () => {
  it('does not reserve a card on hover or focus', () => {
    const source = readFileSync(new URL('./CommandWall.tsx', import.meta.url), 'utf8');
    expect(source).not.toContain('addPreview');
    expect(source).not.toContain('onMouseEnter');
    expect(source).toContain('new Set(), !!addContent');
    expect(source).toContain('data-preview={!!addContent || undefined}');
    expect(source).toContain('onClick={onAddWindow}');
  });
  it('removes duplicate desktop branding and the outer composer fill', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(app).toContain('{!hasAppChrome && <div className="mb-3');
    expect(css).toContain('.wall-composer { position: relative; width: 75%; max-width: 100%; flex-shrink: 0; background: transparent; box-shadow: none; }');
    expect(css).toContain('.send-avatar { margin-right: 4px; }');
  });
});

it('leaves shared composer sizing to CSS and reveals only focused carets', () => {
  const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
  expect(source).toContain("if (!el || !pane || !section || surface === 'composer') return;");
  expect(source).toContain('if (document.activeElement === el) revealEditorCaret(el);');
});

describe('Command Center header spacing', () => {
  it('keeps a compact top inset without changing gutters or toolbar wrapping', () => {
    const source = readFileSync(new URL('../views/CommandCenterView.tsx', import.meta.url), 'utf8');
    expect(source).toContain('gap-3 px-4 pb-4 pt-1 xl:px-6');
    expect(source).toContain('flex flex-wrap items-center gap-x-4 gap-y-2');
    expect(source).not.toContain('pb-4 pt-5');
  });
});

describe('focus full-height chat', () => {
  it('keeps the hero full height and moves other agents out of the stage', () => {
    const g = commandWallGeometry(state({ layout: layout('focus'), hero: 'chat-a' }), 1000, 700);
    expect(g.height).toBe(700);
    expect(g.panes.get('a')?.height).toBe(700);
    expect(g.panes.has('b')).toBe(false);
  });
  it('renders the composer inside the focused chat only', () => {
    const html = renderToStaticMarkup(wall(state({ layout: layout('focus'), hero: 'chat-a' })));
    expect(html).toContain('data-surface="full"');
    expect(html).toContain('data-focus-chat="true"');
  });
  it('suppresses approvals on composer-only surfaces', () => {
    const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
    expect(source).toContain("approval && surface !== 'composer' && <ApprovalBar");
  });
});


it('keeps transcript-only surfaces from overwriting the shared composer draft', () => {
  const source = readFileSync(new URL('./ChatPane.tsx', import.meta.url), 'utf8');
  expect(source).toContain("if (readOnly || surface === 'transcript') return;");
  expect(source).toContain("if (surface === 'transcript' || readOnly) return;");
  expect(source).toContain('Layout cleanup flushes the outgoing composer before the incoming surface restores.');
  expect(source).toContain('}, [sessionId, surface, readOnly]);');
});
