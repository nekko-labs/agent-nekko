import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE, sanitizeWallDock } from '../commandWall.js';
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }));
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => ({ byToken: {}, answered: new Set() }) }));
vi.mock('./InsightsBox.js', () => ({ InsightsBox: () => null }));
vi.mock('./AutomationsPane.js', () => ({ AutomationsPane: () => null }));
vi.mock('./ResourceMonitor.js', () => ({ useMonitors: () => ({}), useResourceSample: () => ({ system: null, gpu: null }) }));
import { WallDock } from './WallDock.js';

function render(side: string) {
  const dock = sanitizeWallDock({ side, panelOrder: ['hardware', 'budget', 'vitals'], panels: { automations: false, utilization: false }, minimized: { budget: true } });
  return renderToStaticMarkup(<WallDock state={{ ...DEFAULT_WALL_STATE, dock }} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
}

describe('dock reorder headers', () => {
  it.each(['left', 'right'])('renders saved order and accessible draggable headers on the %s', side => {
    const html = render(side);
    expect(html.indexOf('Hardware dock panel')).toBeLessThan(html.indexOf('Vitals dock panel'));
    expect(html).toContain('draggable="true" tabindex="0"');
    expect(html).toContain('Hardware panel header; use Alt+ArrowUp or Alt+ArrowDown to reorder');
    expect(html).toContain('aria-label="Expand Budget panel"');
    expect(html).not.toContain('Budget dock panel');
    expect(html).toContain('aria-label="Minimize Hardware panel"');
  });
  it.each(['top', 'bottom'])('does not expose vertical reorder controls on the %s', side => {
    const html = render(side);
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain('Alt+ArrowUp');
  });
});
