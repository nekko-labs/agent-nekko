import React, { useEffect, useRef, useState } from 'react';
import type { AutomationTask, ProviderConfig, RuntimeStatus, SessionSummary, UsageSummary } from '@agent-nekko/shared';
import { RUNTIME_CAPABILITIES, formatUSD, gpuMemoryLabel, isLocalProvider, limitsKeyFor, sanitizeMonthlyBudgetUsd } from '@agent-nekko/shared';
import { DOCK_PANELS, type CommandWallState, type InsightsPrefs, type WallDockPanel } from '../commandWall.js';
import { useStore } from '../store.js';
import { useProviderLimitsPortfolio } from '../useLimits.js';
import { localRuntimeMetrics } from './wallDockMetrics.js';
import { AutomationsPane } from './AutomationsPane.js';
import { InsightsBox, type Vitals } from './InsightsBox.js';
import { useMonitors, useResourceSample } from './ResourceMonitor.js';
import './wallDock.css';

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

  // The wall toolbar owns visibility and restores the hidden dock.
  if (!dock.show) return null;
  const selectedPanels = DOCK_PANELS.filter((p) => dock.panels[p.key]);
  return (
    <aside className="wall-dock" data-dock-side={dock.side} aria-label="Dashboard dock">
      <header className="wall-dock__toolbar">
        <strong>Panels</strong>
        <span className="wall-dock__count">{selectedPanels.length} of {DOCK_PANELS.length}</span>
        <div className="wall-dock__configure" ref={configureRef}>
          <button type="button" ref={configureButton} aria-expanded={configure} onClick={() => setConfigure((v) => !v)}>Configure</button>
          {configure && <div className="wall-dock__popover" role="group" aria-label="Dock configuration">
            <fieldset><legend>Position</legend><div className="wall-dock__positions">
              {(['left', 'right', 'top', 'bottom'] as const).map((side) => <button type="button" key={side} aria-pressed={dock.side === side} onClick={() => patch({ side })}>{side[0].toUpperCase() + side.slice(1)}</button>)}
            </div></fieldset>
            <fieldset><legend>Panels</legend>{DOCK_PANELS.map((p) => <label key={p.key}><input type="checkbox" checked={dock.panels[p.key]} onChange={(e) => panel(p.key, e.target.checked)} /><span className="wall-dock__option"><strong>{p.label}</strong><span>{p.blurb}</span></span></label>)}</fieldset>
          </div>}
        </div>
      </header>
      <div className="wall-dock__panels">
        {selectedPanels.map((p) => <section className={`wall-dock__panel${dock.minimized[p.key] ? ' wall-dock__panel--minimized' : ''}`} key={p.key} aria-label={`${p.label} dock panel`}>
          <header className="wall-dock__panel-header"><h2>{p.label}</h2><button type="button" aria-label={`${dock.minimized[p.key] ? 'Expand' : 'Minimize'} ${p.label} panel`} aria-expanded={!dock.minimized[p.key]} onClick={() => setState((s) => ({ ...s, dock: { ...s.dock, minimized: { ...s.dock.minimized, [p.key]: !s.dock.minimized[p.key] } } }))}>{dock.minimized[p.key] ? 'Expand' : 'Minimize'}</button><button type="button" aria-label={`Remove ${p.label} panel`} onClick={() => panel(p.key, false)}>×</button></header>
          {!dock.minimized[p.key] && <div className="wall-dock__body">
            {p.key === 'vitals' && <InsightsBox {...insightProps} prefs={VITAL_PREFS} onPrefs={() => {}} />}
            {p.key === 'automations' && <AutomationsPane tasks={props.tasks} running={props.running} now={props.now} onOpen={props.onOpenChat} />}
            {p.key === 'utilization' && <Utilization providers={props.providers} usage={props.usage} now={props.now} onOpenModels={props.onOpenModels} />}
            {p.key === 'budget' && <Budget usage={props.usage} now={props.now} />}
            {p.key === 'insights' && <InsightsBox {...insightProps} prefs={state.insights} onPrefs={insights} />}
            {p.key === 'hardware' && <Hardware providers={props.providers} />}
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

function Hardware({ providers }: { providers: ProviderConfig[] }) {
  const monitors = useMonitors();
  const { system, gpu } = useResourceSample();
  const runtimeIds = providers.filter((p) => p.enabled && p.kind in RUNTIME_CAPABILITIES && RUNTIME_CAPABILITIES[p.kind as keyof typeof RUNTIME_CAPABILITIES].canLoad).map((p) => p.id);
  const [statuses, setStatuses] = useState<Array<RuntimeStatus | null>>([]);
  useEffect(() => {
    let live = true;
    const refresh = () => { void Promise.all(runtimeIds.map((id) => window.nekko.runtimeStatus(id).catch(() => null))).then((next) => { if (live) setStatuses(next); }); };
    refresh();
    const timer = setInterval(refresh, 6000);
    return () => { live = false; clearInterval(timer); };
  }, [runtimeIds.join('|')]);
  const util = gpu?.devices.map((d) => d.utilizationPct).filter((n): n is number => n != null && Number.isFinite(n)) ?? [];
  const gpuUtil = util.length ? Math.max(...util) : null;
  const memory = (used: number, total: number) => total > 0 ? (used / 1024).toFixed(1) + ' / ' + (total / 1024).toFixed(1) + ' GiB (' + Math.round(used / total * 100) + '%)' : 'Unavailable';
  const local = localRuntimeMetrics(statuses.filter((s): s is RuntimeStatus => !!s));
  return <div className="wall-dock__metrics">
    <dl>
      <dt>CPU</dt><dd>{!monitors.cpu ? 'Monitor off' : system ? system.cpuPct + '%' : 'Unavailable'}</dd>
      <dt>Memory</dt><dd>{!monitors.memory ? 'Monitor off' : system ? memory(system.memUsedMB, system.memTotalMB) : 'Unavailable'}</dd>
      <dt>GPU (peak device)</dt><dd>{!monitors.gpu ? 'Monitor off' : gpuUtil == null ? 'Unavailable' : gpuUtil + '%'}</dd>
      <dt>{gpu ? gpuMemoryLabel(gpu) : 'VRAM'}</dt><dd>{!monitors.vram ? 'Monitor off' : gpu ? memory(gpu.usedMB, gpu.totalMB) : 'Unavailable'}</dd>
      <dt>Loaded local models</dt><dd>{local.loadedModels}</dd>
      <dt>Loaded model memory</dt><dd>{local.memoryLabel}</dd>
      <dt>Last local tok/s</dt><dd>{local.lastTokPerSecond}</dd>
    </dl>
    {local.recent.length > 0 && <ul>{local.recent.map((r) => <li key={r.id}>{r.id}{r.placement ? ' · ' + r.placement : ''}{r.lastUsed ? ' · last used ' + r.lastUsed : ''}</li>)}</ul>}
    <p>Shared resource sampler — OS{gpu ? ' + ' + gpu.source : ''}. Missing probes are unavailable, not zero. Local model rows use runtime resident-model fields; tokens/sec is shown only when a runtime reports it.</p>
  </div>;
}
