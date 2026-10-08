import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_WALL_STATE } from '../commandWall.js';
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: {} }) }));
const quota = vi.hoisted(() => ({ byToken: {} as Record<string, any>, answered: new Set<string>() }));
vi.mock('../useLimits.js', () => ({ useProviderLimitsPortfolio: () => quota }));
vi.mock('./InsightsBox.js', () => ({ InsightsBox: () => null }));
vi.mock('./AutomationsPane.js', () => ({ AutomationsPane: () => null }));
vi.mock('./ResourceMonitor.js', () => ({ useMonitors: () => ({ cpu: true, memory: true, gpu: true, vram: true }), useResourceSample: () => ({ system: { cpuPct: 18, memUsedMB: 2048, memTotalMB: 8192 }, gpu: null }) }));
import { WallDock } from './WallDock.js';
function render(minimized = false) {
  const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, panels: { vitals: false, automations: false, utilization: false, budget: false, insights: false, hardware: true }, minimized: { ...DEFAULT_WALL_STATE.dock.minimized, hardware: minimized } } };
  return renderToStaticMarkup(<WallDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
}
describe('wall dock presentation', () => {
  it('clarifies stale quota without claiming an active refresh', () => {
    quota.byToken.plan = { updatedAt: 1000, staleAfterMs: 1000, windows: [] };
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, panels: { vitals: false, automations: false, utilization: true, budget: false, insights: false, hardware: false } } };
    const html = renderToStaticMarkup(<WallDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={5000} sessions={[]} providers={[{ id: 'plan', kind: 'chatgpt', label: 'Plan', baseUrl: '', enabled: true, auth: 'subscription', tokenKey: 'plan' }]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('wall-dock__utilization');
    expect(html).toContain('Refresh provider quota');
    expect(html).not.toContain('Quota may be outdated');
    expect(html).not.toContain('Last quota update:');
    expect(html).not.toContain('Stale quota · awaiting refresh');
    quota.byToken = {};
  });
  it.each([[17, 83, 'var(--success)'], [83, 17, 'var(--danger)'], [0, 100, 'var(--success)'], [100, 0, 'var(--danger)']])('shows ChatGPT %i used as %i left with usage-based warnings', (used, left, tone) => {
    quota.byToken = { synthetic: { windows: [{ label: '7-day', usedPercent: used, resetAt: 0 }], updatedAt: 0, staleAfterMs: 60000 } };
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, panels: { vitals: false, automations: false, utilization: true, budget: false, insights: false, hardware: false } } };
    const html = renderToStaticMarkup(<WallDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[{ id: 'chatgpt', baseUrl: '', kind: 'openai', auth: 'subscription', tokenKey: 'synthetic', enabled: true, label: 'ChatGPT' }]} usage={null} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain(`${left}% left`);
    expect(html).toContain(`aria-valuenow="${left}"`);
    expect(html).toContain(`width:${left}%;background:${tone}`);
    quota.byToken = {};
  });
  it('exposes both savings separately and never asks for a monthly budget', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, panels: { vitals: true, automations: false, utilization: false, budget: true, insights: false, hardware: false } } };
    const usage = { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, bySession: {}, byProvider: {}, bySessionCost: {}, daily: [], avoidedCosts: { local: 1.23, subscription: 4.56, benchmarkTokens: 100, unpricedTokens: 200 } };
    const html = renderToStaticMarkup(<WallDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={0} sessions={[]} providers={[]} usage={usage} vitals={{ working: 3, waiting: 1, automations: 2, terminals: 1, tokensToday: 212000, spend: 'Included in plan', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('212K');
    expect(html).toContain('Local AI saved');
    expect(html).toContain('$1.23');
    expect(html).toContain('Subscription saved');
    expect(html).toContain('$4.56');
    expect(html).toContain('200 unpriced tokens excluded');
    expect(html).toContain('Resize Budget panel height');
    expect(html).not.toContain('Monthly budget (USD)');
  });
  it('filters Budget spend and tokens with the Insights time ranges', () => {
    const state = { ...DEFAULT_WALL_STATE, dock: { ...DEFAULT_WALL_STATE.dock, panels: { vitals: false, automations: false, utilization: false, budget: true, insights: false, hardware: false } } };
    const now = Date.parse('2026-10-08T12:00:00Z');
    const usage = { totalInput: 0, totalOutput: 0, totalCost: 0, byModel: {}, bySession: {}, byProvider: {}, bySessionCost: {}, daily: [
      { date: '2026-10-08', input: 100, output: 50, cost: 1 },
      { date: '2026-08-01', input: 1000, output: 500, cost: 10 },
    ] };
    const html = renderToStaticMarkup(<WallDock state={state} setState={vi.fn()} tasks={[]} running={new Set()} now={now} sessions={[]} providers={[]} usage={usage} vitals={{ working: 0, waiting: 0, automations: 0, terminals: 0, tokensToday: 0, spend: '$0', fleet: [] }} onOpenChat={vi.fn()} onOpenModels={vi.fn()} />);
    expect(html).toContain('aria-label="Budget time range"');
    for (const r of ['today', '1wk', '1m', '6m', '1y', 'all-time']) expect(html).toContain(`>${r}</button>`);
    // Default 1m (last 30 days) excludes August.
    expect(html).toContain('last 30 days');
    expect(html).toContain('100 in · 50 out');
    expect(html).toContain('$1.00');
  });
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
