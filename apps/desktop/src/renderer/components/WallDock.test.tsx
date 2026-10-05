import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }));
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => ({ byToken: {}, answered: new Set() }) }));
vi.mock('./InsightsBox.js', () => ({ InsightsBox: () => null }));
vi.mock('./AutomationsPane.js', () => ({ AutomationsPane: () => null }));
vi.mock('./ResourceMonitor.js', () => ({ useMonitors: () => ({ cpu: true, memory: true, gpu: true, vram: true }), useResourceSample: () => ({ system: { cpuPct: 18, memUsedMB: 2048, memTotalMB: 8192 }, gpu: null }) }));
import { WallDock } from './WallDock.js';
function render(minimized = false) {
  const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, panels: { vitals: false, automations: false, utilization: false, budget: false, insights: false, hardware: true }, minimized: { ...DEFAULT_WALL_STATE.dock.minimized, hardware: minimized } } };
  return renderToStaticMarkup(<WallDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
}
describe('wall dock presentation', () => {
  it('uses named icon controls and meters with exact numbers below', () => {
    const html = render();
    expect(html).toContain('aria-label="Minimize Hardware panel"');
    expect(html).toContain('aria-label="Resize panels"');
    expect(html).toContain('role="meter" aria-label="CPU"');
    expect(html).toContain('2.0 / 8.0 GiB (25%)');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('>Minimize</button>');
  });
  it('replaces a minimized panel with a restore icon in the top row', () => {
    const html = render(true);
    expect(html).toContain('aria-label="Minimized panels"');
    expect(html).toContain('aria-label="Expand Hardware panel"');
    expect(html).not.toContain('Hardware dock panel');
    expect(html).not.toContain('role="meter"');
  });
});
