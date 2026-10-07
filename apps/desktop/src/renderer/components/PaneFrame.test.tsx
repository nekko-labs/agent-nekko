import React, { useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { PaneFrame, targetAt } from './PaneFrame.js';
import { ContextAction, ContextMenu } from './ContextMenu.js';

const state = vi.hoisted(() => ({
  settings: null as { chatPaneAction?: 'complete' | 'delete' } | null,
  archiveChat: vi.fn(),
  deleteChatForever: vi.fn(),
}));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState) };
});

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); state.settings = null; });

/** Inspect frame elements and invoke their actual event handlers without a DOM. */
function frame(kind: 'chat' | 'terminal' = 'chat', menu = false, refId = 'session-1', onMinimize?: () => void) {
  vi.mocked(useState).mockImplementation((initial?: unknown) => [initial, vi.fn()] as never);
  vi.mocked(useState).mockReturnValueOnce([null, vi.fn()]);
  vi.mocked(useState).mockReturnValueOnce([menu ? { x: 10, y: 20 } : null, vi.fn()]);
  const onClose = vi.fn();
  const tree = PaneFrame({
    pane: { id: 'pane-1', kind, refId }, title: 'My chat', icon: null,
    isActive: true, dragging: null, canSplit: () => true, onSplit: vi.fn(),
    onClose, onMinimize, onFocus: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(), onDrop: vi.fn(), children: null,
  });
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement<Record<string, any>>(child)) return;
      elements.push(child);
      walk(child.props.children);
    });
  };
  walk(tree);
  return { elements, onClose, button: elements.find((e) => e.type === 'button')! };
}

describe('pane lifecycle controls', () => {
  it('places wall minimize immediately before Complete without archiving or deleting', () => {
    const minimize = vi.fn();
    const { elements } = frame('chat', false, 'session-1', minimize);
    const buttons = elements.filter((e) => e.type === 'button');
    expect(buttons.map((e) => e.props['aria-label'])).toEqual(['Minimize My chat', 'Complete My chat']);
    buttons[0].props.onClick();
    expect(minimize).toHaveBeenCalledOnce();
    expect(state.archiveChat).not.toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
  });

  it('does not expose chat minimize on terminal windows', () => {
    const { elements } = frame('terminal', false, 'terminal-1', vi.fn());
    expect(elements.some((e) => e.props['aria-label'] === 'Minimize My chat')).toBe(false);
  });
  it('defaults chats to Complete using existing archive semantics, not Close', () => {
    const { button, onClose } = frame();
    expect(button.props['aria-label']).toBe('Complete My chat');
    expect(button.props.title).toBe('Complete this chat');
    button.props.onClick();
    expect(state.archiveChat).toHaveBeenCalledWith('session-1');
    expect(onClose).not.toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
  });

  it.each([false, true])('confirms the Delete preference (approved=%s)', (approved) => {
    state.settings = { chatPaneAction: 'delete' };
    const confirm = vi.fn(() => approved);
    vi.stubGlobal('window', { confirm });
    const { button, onClose } = frame();
    expect(button.props['aria-label']).toBe('Delete My chat');
    button.props.onClick();
    expect(confirm).toHaveBeenCalledWith('Delete this chat forever? It cannot be recovered.');
    expect(state.deleteChatForever).toHaveBeenCalledTimes(approved ? 1 : 0);
    if (approved) expect(state.deleteChatForever).toHaveBeenCalledWith('session-1');
    expect(state.archiveChat).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers Complete, confirmed Delete, and non-destructive Close regardless of preference', () => {
    state.settings = { chatPaneAction: 'delete' };
    vi.stubGlobal('window', { confirm: vi.fn(() => false) });
    const { elements, onClose } = frame('chat', true);
    expect(elements.some((e) => e.type === ContextMenu)).toBe(true);
    const actions = elements.filter((e) => e.type === ContextAction);
    expect(actions.map((e) => e.props.children)).toEqual(['Complete', 'Delete', 'Close']);
    actions[0].props.onClick();
    expect(state.archiveChat).toHaveBeenCalledWith('session-1');
    actions[1].props.onClick();
    expect(window.confirm).toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
    actions[2].props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens the title-bar menu without bubbling to parent menus', () => {
    const { elements } = frame();
    const strip = elements.find((e) => e.props.draggable)!;
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 30, clientY: 40 };
    strip.props.onContextMenu(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(vi.mocked(useState).mock.results[1].value[1]).toHaveBeenCalledWith({ x: 30, y: 40 });
  });

  it.each([['terminal', 'terminal-1'], ['chat', '']] as const)('keeps Close for %s panes with ref %s', (kind, refId) => {
    state.settings = { chatPaneAction: 'delete' };
    const { button, elements, onClose } = frame(kind, true, refId);
    expect(button.props['aria-label']).toBe('Close My chat');
    button.props.onClick();
    expect(onClose).toHaveBeenCalledOnce();
    expect(elements.filter((e) => e.type === ContextAction).map((e) => e.props.children)).toEqual(['Close']);
    expect(state.archiveChat).not.toHaveBeenCalled();
    expect(state.deleteChatForever).not.toHaveBeenCalled();
  });
});

/** A 200×100 window at the origin, the shape most drops land on. */
const rect = { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 } as DOMRect;

describe('targetAt', () => {
  it('reads the nearest edge, so each corner belongs to its shorter side', () => {
    expect(targetAt(rect, 5, 50)).toBe('left');
    expect(targetAt(rect, 195, 50)).toBe('right');
    expect(targetAt(rect, 100, 5)).toBe('up');
    expect(targetAt(rect, 100, 95)).toBe('down');
  });

  it('splits the edges into four triangles rather than four bands', () => {
    // Nearer the top than the left in *fractions* of the window, even though
    // the top is further away in pixels: a wide window's bands are wide too.
    expect(targetAt(rect, 30, 10)).toBe('up');
    expect(targetAt(rect, 10, 30)).toBe('left');
  });

  it('offers a swap in the middle, which no edge could express', () => {
    // Dropping a window on the left edge of the neighbour already to its right
    // reproduces the order it was in, so "put these two the other way round"
    // needs a target of its own rather than an edge.
    expect(targetAt(rect, 100, 50)).toBe('swap');
  });

  it('keeps the edges reachable from anywhere near them', () => {
    // The swap zone is generous, but every edge stays a short move away: a
    // pointer a tenth of the way in still means the edge it is nearest.
    expect(targetAt(rect, 20, 50)).toBe('left');
    expect(targetAt(rect, 180, 50)).toBe('right');
    expect(targetAt(rect, 100, 10)).toBe('up');
    expect(targetAt(rect, 100, 90)).toBe('down');
  });

  it('survives a window that has been measured at zero size', () => {
    const empty = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 } as DOMRect;
    expect(['up', 'down', 'left', 'right', 'swap']).toContain(targetAt(empty, 0, 0));
  });
});
