import React, { useEffect, useRef, useState } from 'react';
import type { AutomationTask, ProviderConfig, SessionSummary, UsageSummary } from '@agent-nekko/shared';
import { formatUSD, gpuMemoryLabel, isLocalProvider, limitsKeyFor, sanitizeMonthlyBudgetUsd } from '@agent-nekko/shared';
import { DOCK_PANELS, type CommandWallState, type InsightsPrefs, type WallDockPanel } from '../commandWall.js';
import { useStore } from '../store.js';
import { useProviderLimitsPortfolio } from '../useLimits.js';
import { AutomationsPane } from './AutomationsPane.js';
import { InsightsBox, type Vitals } from './InsightsBox.js';
import { useMonitors, useResourceSample } from './ResourceMonitor.js';
import { BoltIcon, BrainIcon, ServerIcon, GridIcon, ListIcon, GearIcon, CloseIcon, DownloadIcon } from '../icons.js';
import './wallDock.css';
import { dockMinimizeTransition } from './dockMinimize.js';

const PANEL_ICONS = { vitals: BoltIcon, automations: GearIcon, utilization: ListIcon, budget: GridIcon, insights: BrainIcon, hardware: ServerIcon };

export interface WallDockProps {
  state: CommandWallState;
  setState: (update: (state: CommandWallState) => CommandWallState) => void;
  tasks: AutomationTask[];
  running: Set<string>;
  now: number;
  sessions: SessionSummary[];
  providers: ProviderConfig[];
  usage: UsageSummary | null;
  vitals: Vitals;
  onOpenChat: (id: string) => void;
  onOpenModels: () => void;
}

const VITAL_PREFS: InsightsPrefs = { panels: { vitals: true, optimize: false, cost: false, tokens: false, models: false, replies: false, services: false } };

/** A flow-layout sibling of the wall stage. The parent places it using data-dock-side. */
export function WallDock(props: WallDockProps) {
  const { state, setState } = props;
  const { dock } = state;
  const [width, setWidth] = useState(340);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const size = (value: number) => { const next = Math.max(260, Math.min(600, value)); setWidth(Math.abs(next - 340) <= 20 ? 340 : next); };
  const [collapsing, setCollapsing] = useState<WallDockPanel | null>(null);
  const dockRef = useRef<HTMLElement>(null);
  const focusPanel = useRef<{ key: WallDockPanel; minimized: boolean } | null>(null);
  const minimizeTransition = useRef(dockMinimizeTransition());
  useEffect(() => () => minimizeTransition.current.cancel(), []);
  useEffect(() => {
    const pending = focusPanel.current;
    if (!pending || Boolean(dock.minimized[pending.key]) !== pending.minimized) return;
    const label = DOCK_PANELS.find(p => p.key === pending.key)!.label;
    dockRef.current?.querySelector<HTMLButtonElement>(`button[aria-label="${pending.minimized ? 'Expand' : 'Minimize'} ${label} panel"]`)?.focus();
    focusPanel.current = null;
  }, [dock.minimized]);
  const [configure, setConfigure] = useState(false);
  const configureRef = useRef<HTMLDivElement>(null);
  const configureButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!configure) return;
    const down = (e: MouseEvent) => { if (!configureRef.current?.contains(e.target as Node)) setConfigure(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setConfigure(false); configureButton.current?.focus(); }
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key); };
  }, [configure]);
  const patch = (next: Partial<CommandWallState['dock']>) => setState((s) => ({ ...s, dock: { ...s.dock, ...next } }));
  const panel = (key: WallDockPanel, enabled: boolean) => setState((s) => ({ ...s, dock: { ...s.dock, panels: { ...s.dock.panels, [key]: enabled } } }));
  const insights = (prefs: InsightsPrefs) => setState((s) => ({ ...s, insights: prefs }));
  const insightProps = { usage: props.usage, sessions: props.sessions, providers: props.providers, vitals: props.vitals, onOpenModels: props.onOpenModels };

  const minimize = (key: WallDockPanel, value: boolean) => {
    minimizeTransition.current.cancel();
    const commit = () => {
      focusPanel.current = { key, minimized: value };
      setState((s) => ({ ...s, dock: { ...s.dock, minimized: { ...s.dock.minimized, [key]: value } } }));
      setCollapsing(null);
    };
    minimizeTransition.current.start(!value || window.matchMedia('(prefers-reduced-motion: reduce)').matches, () => setCollapsing(key), commit);
  };

  // The wall toolbar owns visibility and restores the hidden dock.
  if (!dock.show) return null;
  const selectedPanels = DOCK_PANELS.filter((p) => dock.panels[p.key]);
  return (
    <aside ref={dockRef} className="wall-dock" style={{ '--dock-width': `${width}px` } as React.CSSProperties} data-dock-side={dock.side} aria-label="Dashboard dock">
      {(dock.side === 'left' || dock.side === 'right') && <div className="wall-dock__resize" role="separator" tabIndex={0} aria-label="Resize panels" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={600} aria-valuenow={width} title="Drag to resize panels; double-click to reset"
        onPointerDown={(e) => { drag.current = { x: e.clientX, width }; e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (drag.current) size(Math.min((e.currentTarget.parentElement?.parentElement?.clientWidth ?? 1000) - 240, drag.current.width + (e.clientX - drag.current.x) * (dock.side === 'left' ? 1 : -1))); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onDoubleClick={() => setWidth(340)}
        onKeyDown={(e) => { if (e.key === 'Home') { e.preventDefault(); setWidth(340); } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); size(width + (e.key === 'ArrowRight' ? 24 : -24) * (dock.side === 'left' ? 1 : -1)); } }} />}
      <header className="wall-dock__toolbar">
        <strong>Panels</strong>
        <span className="wall-dock__count">{selectedPanels.length} of {DOCK_PANELS.length}</span>
        <div className="wall-dock__configure" ref={configureRef}>
          <button type="button" ref={configureButton} aria-expanded={configure} onClick={() => setConfigure((v) => !v)} title="Configure panels" aria-label="Configure panels"><GearIcon className="wall-dock__icon" /></button>
          {configure && <div className="wall-dock__popover" role="group" aria-label="Dock configuration">
            <fieldset><legend>Position</legend><div className="wall-dock__positions">
              {(['left', 'right', 'top', 'bottom'] as const).map((side) => <button type="button" key={side} aria-pressed={dock.side === side} onClick={() => patch({ side })}>{side[0].toUpperCase() + side.slice(1)}</button>)}
            </div></fieldset>
            <fieldset><legend>Panels</legend>{DOCK_PANELS.map((p) => <label key={p.key}><input type="checkbox" checked={dock.panels[p.key]} onChange={(e) => panel(p.key, e.target.checked)} /><span className="wall-dock__option"><strong>{p.label}</strong><span>{p.blurb}</span></span></label>)}</fieldset>
          </div>}
        </div>
      </header>
      {selectedPanels.some((p) => dock.minimized[p.key]) && <div className="wall-dock__minimized" role="group" aria-label="Minimized panels">
        {selectedPanels.filter((p) => dock.minimized[p.key]).map((p) => { const Icon = PANEL_ICONS[p.key]; return <button key={p.key} type="button" title={`Restore ${p.label}`} aria-label={`Expand ${p.label} panel`} aria-expanded={false} onClick={() => minimize(p.key, false)}><Icon className="wall-dock__icon" /></button>; })}
      </div>}
      <div className="wall-dock__panels">
        {selectedPanels.filter((p) => !dock.minimized[p.key]).map((p) => <section className={`wall-dock__panel${collapsing === p.key ? ' wall-dock__panel--collapsing' : ''}`} key={p.key} aria-label={`${p.label} dock panel`}>
          <header className="wall-dock__panel-header"><span className="wall-dock__panel-icon">{React.createElement(PANEL_ICONS[p.key], { className: 'wall-dock__icon' })}</span><h2>{p.label}</h2><button type="button" title={`Minimize ${p.label}`} aria-label={`Minimize ${p.label} panel`} aria-expanded={true} disabled={collapsing !== null} onClick={() => minimize(p.key, true)}><DownloadIcon className="wall-dock__icon" /></button><button type="button" title={`Remove ${p.label}`} aria-label={`Remove ${p.label} panel`} onClick={() => panel(p.key, false)}><CloseIcon className="wall-dock__icon" /></button></header>
          {!dock.minimized[p.key] && <div className="wall-dock__body">
            {p.key === 'vitals' && <InsightsBox {...insightProps} prefs={VITAL_PREFS} onPrefs={() => {}} />}
            {p.key === 'automations' && <AutomationsPane tasks={props.tasks} running={props.running} now={props.now} onOpen={props.onOpenChat} />}
            {p.key === 'utilization' && <Utilization providers={props.providers} usage={props.usage} now={props.now} onOpenModels={props.onOpenModels} />}
            {p.key === 'budget' && <Budget usage={props.usage} now={props.now} />}
            {p.key === 'insights' && <InsightsBox {...insightProps} prefs={state.insights} onPrefs={insights} />}
            {p.key === 'hardware' && <Hardware />}
          </div>}
        </section>)}
        {selectedPanels.length === 0 && <p className="wall-dock__empty">No panels selected. Use Configure to restore them.</p>}
      </div>
    </aside>
  );
}

function Utilization({ providers, usage, now, onOpenModels }: Pick<WallDockProps, 'providers' | 'usage' | 'now' | 'onOpenModels'>) {
  const enabled = providers.filter((p) => p.enabled);
  const { byToken, answered } = useProviderLimitsPortfolio(enabled);
  const today = new Date(now).toISOString().slice(0, 10);
  const weekStart = new Date(`${today}T00:00:00Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - (weekStart.getUTCDay() + 6) % 7);
  const week = weekStart.toISOString().slice(0, 10);
  const todayTokens = usage?.daily.filter((d) => d.date === today).reduce((sum, d) => sum + d.input + d.output, 0);
  const weekTokens = usage?.daily.filter((d) => d.date >= week && d.date <= today).reduce((sum, d) => sum + d.input + d.output, 0);
  return <div className="wall-dock__metrics">
    <p>Recorded tokens today (UTC): {todayTokens == null ? 'Unavailable' : todayTokens.toLocaleString()}</p>
    <p>Recorded tokens this week (Monday–today, UTC): {weekTokens == null ? 'Unavailable' : weekTokens.toLocaleString()}</p>
    <p>Input + output from daily recorded usage; not unrecorded provider activity.</p>
    {enabled.length === 0 && <p>No enabled providers.</p>}
    {enabled.map((provider) => {
      const key = limitsKeyFor(provider);
      const limits = key ? byToken[key] : undefined;
      const windows = limits?.windows ?? [];
      const status = isLocalProvider(provider.kind) ? 'Local provider — no quota API.'
        : provider.auth === 'subscription' && !provider.tokenKey ? 'Not signed in.'
        : !key ? 'Usage API unavailable.'
        : !limits ? (answered.has(key) ? 'Quota unavailable (not reported or read failed).' : 'Reading provider quota…')
        : windows.length === 0 ? 'No quota windows reported.' : null;
      return <div key={provider.id} className="wall-dock__provider"><strong>{provider.label}</strong>
        {status && <p>{status}</p>}
        {limits?.creditsState === 'balance' && limits.creditsBalance != null && <p>Reported credit balance: {formatUSD(limits.creditsBalance)}</p>}
        {limits?.creditsState === 'disabled' && <p>Extra usage credits disabled.</p>}
        {limits && <p>Snapshot: {new Date(limits.updatedAt).toLocaleString()}{now - limits.updatedAt > limits.staleAfterMs ? ' · stale, awaiting refresh' : ''}</p>}
        {windows.map((w, i) => <div key={`${w.label}-${i}`}><p>{w.label}: {Number.isFinite(w.usedPercent) ? `${Math.round(w.usedPercent)}% used` : 'Usage unavailable'}{w.resetAt ? ` · resets ${new Date(w.resetAt).toLocaleString()}` : ''}{w.resetAt && w.resetAt <= now ? ' (awaiting refresh)' : ''}</p>
          {Number.isFinite(w.usedPercent) && <progress aria-label={`${provider.label} ${w.label} used`} max={100} value={Math.max(0, Math.min(100, w.usedPercent))} />}
        </div>)}
      </div>;
    })}
    <p>Provider-reported quotas, not billing or model throughput.</p>
    <button type="button" onClick={onOpenModels}>Manage models &amp; providers</button>
  </div>;
}

function Budget({ usage, now }: Pick<WallDockProps, 'usage' | 'now'>) {
  const settings = useStore((s) => s.settings);
  const budget = sanitizeMonthlyBudgetUsd(settings?.monthlyBudgetUsd);
  const [draft, setDraft] = useState(budget == null ? '' : String(budget));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(budget == null ? '' : String(budget)); }, [budget]);
  const month = new Date(now).toISOString().slice(0, 7);
  const spend = usage?.daily.filter((d) => d.date.startsWith(`${month}-`)).reduce((sum, d) => sum + d.cost, 0);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = draft.trim() === '' ? undefined : Number(draft);
    if (value !== undefined && sanitizeMonthlyBudgetUsd(value) === undefined) { setError('Enter a finite, non-negative USD amount.'); return; }
    setSaving(true); setError(null);
    try {
      // Explicit null survives the web JSON bridge; undefined would omit the patch.
      // The settings sanitizer treats null as unset (the public setting is optional).
      await window.nekko.updateSettings({ monthlyBudgetUsd: value ?? (null as unknown as undefined) });
      await useStore.getState().refreshSettings();
    } catch { setError('Could not save or refresh the budget. Please try again.'); }
    finally { setSaving(false); }
  };
  return <div className="wall-dock__metrics">
    <p><strong>{spend == null ? 'Spend unavailable' : formatUSD(spend)}</strong> estimated recorded spend · {month} (UTC)</p>
    <p>{budget == null ? 'No monthly budget set.' : `Advisory budget: ${formatUSD(budget)}`}</p>
    {spend != null && budget != null && <>
      <p>{spend > budget ? `${formatUSD(spend - budget)} over budget` : `${formatUSD(budget - spend)} remaining`}</p>
      {budget > 0 && <progress aria-label="Monthly budget used" max={budget} value={Math.min(spend, budget)} />}
    </>}
    <form onSubmit={save}><label>Monthly budget (USD)<input type="number" min="0" step="any" value={draft} placeholder="Not set" disabled={!settings || saving} onChange={(e) => setDraft(e.target.value)} /></label><button type="submit" disabled={!settings || saving}>{saving ? 'Saving…' : 'Save'}</button></form>
    {error && <p role="alert">{error}</p>}
    <p>Advisory only, not a spending limit or bill. Estimates cover recorded usage, not subscription fees. Leave blank to clear.</p>
  </div>;
}

function Hardware() {
  const monitors = useMonitors();
  const { system, gpu } = useResourceSample();
  const util = gpu?.devices.map((d) => d.utilizationPct).filter((n): n is number => n != null && Number.isFinite(n)) ?? [];
  const gpuUtil = util.length ? Math.max(...util) : null;
  const memory = (used: number, total: number) => total > 0 ? `${(used / 1024).toFixed(1)} / ${(total / 1024).toFixed(1)} GiB (${Math.round(used / total * 100)}%)` : 'Unavailable';
  const rows = [
    { label: 'CPU', value: !monitors.cpu ? null : system?.cpuPct ?? null, text: !monitors.cpu ? 'Monitor off' : system ? `${system.cpuPct}%` : 'Unavailable', color: 'var(--accent)' },
    { label: 'Memory', value: monitors.memory && system && system.memTotalMB > 0 ? system.memUsedMB / system.memTotalMB * 100 : null, text: !monitors.memory ? 'Monitor off' : system ? memory(system.memUsedMB, system.memTotalMB) : 'Unavailable', color: 'var(--accent-2)' },
    { label: 'GPU (peak device)', value: monitors.gpu ? gpuUtil : null, text: !monitors.gpu ? 'Monitor off' : gpuUtil == null ? 'Unavailable' : `${gpuUtil}%`, color: 'var(--success)' },
    { label: gpu ? gpuMemoryLabel(gpu) : 'VRAM', value: monitors.vram && gpu && gpu.totalMB > 0 ? gpu.usedMB / gpu.totalMB * 100 : null, text: !monitors.vram ? 'Monitor off' : gpu ? memory(gpu.usedMB, gpu.totalMB) : 'Unavailable', color: 'var(--warning)' },
  ];
  return <div className="wall-dock__metrics wall-dock__hardware">
    {rows.map((row) => <div className="wall-dock__meter" key={row.label}>
      <strong>{row.label}</strong>
      <div className="wall-dock__bar" role={row.value == null ? undefined : 'meter'} aria-label={row.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.value == null ? undefined : Math.max(0, Math.min(100, row.value))}>
        {row.value != null && <span style={{ width: `${Math.max(0, Math.min(100, row.value))}%`, background: row.color }} />}
      </div><span className="wall-dock__reading">{row.text}</span>
    </div>)}
    <p>Shared resource sampler · OS{gpu ? ` + ${gpu.source}` : ''}. Missing probes are unavailable, not zero. Monitor switches follow Settings.</p>
  </div>;
}
