import React, { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentWindowPicker } from './AgentWindowPicker.js';
import { ModelPicker } from './agent-console/ModelPicker.js';

const state = vi.hoisted(() => ({
  sessions: [{ id: 'chat-1', title: 'Active chat' }, { id: 'image-1', title: 'Pictures', chatType: 'image' }, { id: 'archived', title: 'Archived', archivedAt: 1 }],
  terminals: [{ id: 'term-1', title: 'Shell', cwd: '/project', running: true }, { id: 'term-2', title: 'Old shell', cwd: '/project', running: false }],
  providers: [{ id: 'p', enabled: true }, { id: 'disabled', enabled: false }],
  models: [{ id: 'm', providerId: 'p', name: 'Model' }],
  activeProviderId: 'p',
}));
vi.mock('../store.js', () => ({ useStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('./agent-console/ModelPicker.js', () => ({ ModelPicker: () => null }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState), useRef: vi.fn(actual.useRef), useEffect: vi.fn(), useMemo: (fn: () => unknown) => fn() };
});
afterEach(() => vi.clearAllMocks());

function picker(category: 'chat' | 'media' | 'terminal' | null = null, choice: { providerId: string; modelId: string } | null = null, pending = false, error: string | null = null, onAdd = vi.fn(async () => {})) {
  const setters = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
  [category, choice, pending, error].forEach((value, i) => vi.mocked(useState).mockReturnValueOnce([value, setters[i]] as never));
  vi.mocked(useRef).mockReturnValueOnce({ current: false }).mockReturnValueOnce({ current: null });
  const onClose = vi.fn();
  const tree = AgentWindowPicker({ onAdd, onClose });
  const elements: React.ReactElement<Record<string, any>>[] = [];
  const walk = (node: React.ReactNode) => React.Children.forEach(node, (child) => {
    if (!React.isValidElement<Record<string, any>>(child)) return;
    elements.push(child);
    walk(child.props.children);
  });
  walk(tree);
  const text = (node: React.ReactNode): string => React.Children.toArray(node).map((child) => React.isValidElement<{ children?: React.ReactNode }>(child) ? text(child.props.children) : typeof child === 'string' ? child : '').join('');
  const button = (label: string) => elements.find((e) => e.type === 'button' && text(e.props.children).includes(label))!;
  return { elements, setters, onAdd, onClose, button };
}

describe('AgentWindowPicker', () => {
  it('starts with three accessible category buttons and closes only on request', () => {
    const view = picker();
    for (const [label, category] of [['Chat', 'chat'], ['Media', 'media'], ['Terminal', 'terminal']]) {
      expect(view.button(label).props.type).toBe('button');
      view.button(label).props.onClick();
      expect(view.setters[0]).toHaveBeenCalledWith(category);
    }
    expect(view.elements.filter((e) => e.type === ModelPicker)).toHaveLength(0);
    expect(view.onAdd).not.toHaveBeenCalled();
    view.button('Close').props.onClick();
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it('dismisses with Escape and stops wall keyboard propagation', () => {
    const view = picker();
    const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };
    view.elements[0].props.onKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it('uses inline read-only ModelPicker and requires an explicit choice before creation', () => {
    const view = picker('chat');
    const modelPicker = view.elements.find((e) => e.type === ModelPicker)!;
    expect(modelPicker.props).toMatchObject({ expanded: true, open: true, readOnly: true, modelId: null, providers: [state.providers[0]] });
    expect(view.button('Create chat').props.disabled).toBe(true);
    modelPicker.props.onModel('p2', 'm2');
    expect(view.setters[1]).toHaveBeenCalledWith({ providerId: 'p2', modelId: 'm2' });
    expect(view.onAdd).not.toHaveBeenCalled();
  });

  it('creates a chat using the chosen model without changing active store selection', async () => {
    const view = picker('chat', { providerId: 'p2', modelId: 'm2' });
    expect(view.elements.find((e) => e.type === ModelPicker)!.props.models).toEqual([]);
    await view.button('Create chat').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'multimodal', providerId: 'p2', modelId: 'm2' });
    expect(state.activeProviderId).toBe('p');
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it('omits an empty provider id for Auto routing', async () => {
    const view = picker('chat', { providerId: '', modelId: 'auto' });
    await view.button('Create chat').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'multimodal', modelId: 'auto' });
  });

  it('excludes archived chats and preserves image type when opening', async () => {
    const view = picker('chat');
    expect(view.button('Archived')).toBeUndefined();
    await view.button('Pictures').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', refId: 'image-1', chatType: 'image' });
    await view.button('Active chat').props.onClick();
    expect(view.onAdd).toHaveBeenLastCalledWith({ kind: 'chat', refId: 'chat-1', chatType: 'multimodal' });
  });

  it('creates images but honestly disables planned video', async () => {
    const view = picker('media');
    expect(view.button('Video · Planned').props.disabled).toBe(true);
    expect(view.button('Video · Planned').props.onClick).toBeUndefined();
    await view.button('Create image session').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'chat', chatType: 'image' });
  });

  it('supports new and existing terminals, including exited shells', async () => {
    const view = picker('terminal');
    await view.button('Create terminal').props.onClick();
    expect(view.onAdd).toHaveBeenCalledWith({ kind: 'terminal' });
    await view.button('Old shell').props.onClick();
    expect(view.onAdd).toHaveBeenLastCalledWith({ kind: 'terminal', refId: 'term-2' });
  });

  it('guards double clicks while pending, exposes errors and permits retry', async () => {
    let reject!: (reason: Error) => void;
    const onAdd = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    const view = picker('terminal', null, false, null, onAdd);
    view.button('Create terminal').props.onClick();
    view.button('Create terminal').props.onClick();
    expect(onAdd).toHaveBeenCalledOnce();
    reject(new Error('Permission denied'));
    await Promise.resolve();
    await Promise.resolve();
    expect(view.setters[3]).toHaveBeenCalledWith('Permission denied');
    expect(view.setters[2]).toHaveBeenLastCalledWith(false);
    onAdd.mockResolvedValueOnce();
    view.button('Create terminal').props.onClick();
    expect(onAdd).toHaveBeenCalledTimes(2);
    const failed = picker('terminal', null, false, 'Permission denied');
    expect(failed.elements.find((e) => e.props.role === 'alert')!.props.children).toContain('Permission denied');
  });

  it('disables navigation and selections while adding and announces progress', () => {
    const view = picker('chat', null, true);
    expect(view.elements.filter((e) => e.type === 'button').every((e) => e.props.disabled)).toBe(true);
    expect(view.elements.find((e) => e.type === 'fieldset')!.props.disabled).toBe(true);
    expect(view.elements.some((e) => e.props.role === 'status')).toBe(true);
  });
});
