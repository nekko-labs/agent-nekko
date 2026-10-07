import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ chrome: true, mac: false, view: 'command' }));
vi.mock('../chrome.js', () => ({ get hasAppChrome() { return state.chrome; }, get isMacChrome() { return state.mac; } }));
vi.mock('../store.js', () => ({ useStore: Object.assign((select: (s: { view: string }) => unknown) => select({ view: state.view }), { getState: () => ({}) }) }));
vi.mock('../components/UpdateBanner.js', () => ({ UpdateControl: () => null }));
vi.mock('../components/DeveloperServerControls.js', () => ({ DeveloperServerControls: () => null }));
vi.mock('../components/AgentWindowPicker.js', () => ({ AgentWindowPicker: () => null }));
vi.mock('../components/InsightsBox.js', () => ({}));
vi.mock('../components/CommandWall.js', () => ({ CommandWall: () => null, TerminalExcerpt: () => null }));
vi.mock('../components/WallComposer.js', () => ({ WallComposer: () => null }));
vi.mock('../components/WallDock.js', () => ({ WallDock: () => null }));
import { TitleBar } from '../components/TitleBar.js';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
import { WallToolbar } from './CommandCenterView.js';

const toolbar = () => renderToStaticMarkup(<WallToolbar wall={DEFAULT_WALL_STATE} setWall={() => {}} onAutoArrange={() => {}} addOpen={false} setAddOpen={() => {}} />);

describe('Agents header placement', () => {
  beforeEach(() => { state.chrome = true; state.mac = false; state.view = 'command'; });
  it.each([false, true])('puts a single heading beside the brand in desktop chrome (mac=%s)', (mac) => {
    state.mac = mac;
    const title = renderToStaticMarkup(<TitleBar />);
    expect(title).toContain('Agent Nekko</span>');
    expect(title).toMatch(/id="command-titlebar-slot"[^>]*><h1[^>]*>Agents<\/h1>/);
    expect(title.match(/<h1/g)).toHaveLength(1);
    expect(toolbar()).not.toContain('<h1');
    expect(title).not.toContain('pr-[150px]');
  });
  it('does not label other desktop views as Agents', () => {
    state.view = 'settings';
    expect(renderToStaticMarkup(<TitleBar />)).not.toContain('<h1');
  });
  it('keeps the in-view heading when there is no desktop title bar', () => {
    state.chrome = false;
    expect(renderToStaticMarkup(<TitleBar />)).toBe('');
    expect(toolbar()).toMatch(/<h1[^>]*>Agents<\/h1>/);
  });
  it.each([true, false])('removes wall counts while retaining all controls (chrome=%s)', (chrome) => {
    state.chrome = chrome;
    const html = toolbar();
    expect(html).not.toContain('on the wall');
    expect(html).not.toContain('0 agents');
    expect(html).not.toContain('0 terminals');
    for (const label of ['Wall layout', 'Focus', 'Grid', 'Fixed', 'Show', 'Auto-arrange', 'Panels', 'Add window']) expect(html).toContain(label);
  });
});
