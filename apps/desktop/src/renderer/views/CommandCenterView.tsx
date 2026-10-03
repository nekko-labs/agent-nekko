import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AutomationTask, PendingInput, SessionSummary, UsageSummary } from '@agent-nekko/shared';
import type { AgentType } from '@agent-nekko/shared';
import { classifyAgent, classifySession, formatUSD, summarizeSession, taskCadence } from '@agent-nekko/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { PanelList, Toggle } from '../components/primitives/index.js';
import { GridIcon, TrashIcon } from '../icons.js';
import { CommandGrid } from '../components/CommandGrid.js';
import { InsightsBox, type Vitals } from '../components/InsightsBox.js';
import { AutomationsEmptyArt, EmptyArea } from '../components/EmptyIllustrations.js';
import {
  GRID_MAX,
  addCells,
  loadGridState,
  reconcileGrid,
  saveGridState,
  type CommandGridState,
  type GridFilter,
} from '../commandGrid.js';

const HOUR = 60 * 60_000;

/**
 * The Command Center: every agent and terminal as a live window on one wall,
 * in a consistent grid you can reshape, with the automations list and the
 * insights box around it. The grid is the same chat and terminal panes the
 * Agent tab shows, so work gets handled here, not just watched.
 */
export function CommandCenterView() {
  const { sessions, terminals, providers, settings, activeProjectId, setView, openChatPane, openTerminalPane, refreshSessions, refreshTerminals } = useStore(
    useShallow((s) => ({
      sessions: s.sessions,
      terminals: s.terminals,
      providers: s.providers,
      settings: s.settings,
      activeProjectId: s.activeProjectId,
      setView: s.setView,
      openChatPane: s.openChatPane,
      openTerminalPane: s.openTerminalPane,
      refreshSessions: s.refreshSessions,
      refreshTerminals: s.refreshTerminals,
    })),
  );
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  // What each chat is waiting on a person for, read from the host so a question
  // asked while this screen was closed shows on its window when it opens.
  const [pending, setPending] = useState<Record<string, PendingInput>>({});
  const [, setTick] = useState(0);
  const now = Date.now();

  // The wall itself: remembered between runs, kept honest against the chats
  // and terminals that exist, and grown by every new chat while auto-add is on.
  const [grid, setGridState] = useState<CommandGridState>(() => loadGridState(typeof localStorage === 'undefined' ? undefined : localStorage));
  const setGrid = (update: (s: CommandGridState) => CommandGridState) => setGridState((s) => update(s));
  useEffect(() => { saveGridState(typeof localStorage === 'undefined' ? undefined : localStorage, grid); }, [grid]);
  // Not before both lists have loaded once: reconciling against the empty
  // lists the view mounts with would seed an empty wall and watermark every
  // chat that already exists out of it.
  const [listsReady, setListsReady] = useState(false);
  useEffect(() => {
    if (listsReady) setGridState((g) => reconcileGrid(g, sessions, terminals, Date.now()));
  }, [listsReady, sessions, terminals]);

  useEffect(() => {
    window.nekko.getUsageSummary().then(setUsage);
    Promise.all([refreshSessions(), refreshTerminals()]).finally(() => setListsReady(true));
    window.nekko.listTasks().then(setTasks).catch(() => setTasks([]));
    window.nekko.pendingInput().then(setPending).catch(() => {});
    const off = window.nekko.onTasksUpdated(setTasks);
    return off;
  }, [refreshSessions, refreshTerminals]);

  const refreshPending = () => { window.nekko.pendingInput().then(setPending).catch(() => {}); };

  const taskBySession = useMemo(() => {
    const m = new Map<string, AutomationTask>();
    for (const t of tasks) if (t.lastSessionId) m.set(t.lastSessionId, t);
    return m;
  }, [tasks]);

  // Track running sessions live; a freshly spawned sub-agent re-lists sessions,
  // which is how it reaches the grid.
  useEffect(() => {
    const known = new Set(sessions.map((s) => s.id));
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'question' || e.type === 'tool_approval_required' || e.type === 'question_resolved' || e.type === 'tool_result') refreshPending();
      if (e.type === 'done' || e.type === 'error') {
        setRunning((r) => { const n = new Set(r); n.delete(e.sessionId); return n; });
        window.nekko.getUsageSummary().then(setUsage);
        refreshPending();
        refreshSessions();
      } else {
        setRunning((r) => (r.has(e.sessionId) ? r : new Set(r).add(e.sessionId)));
      }
      if (!known.has(e.sessionId)) { known.add(e.sessionId); refreshSessions(); }
    });
    return off;
  }, [sessions, refreshSessions]);

  // The automation countdowns tick every 30s.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const childrenOf = useMemo(() => {
    const m = new Map<string, SessionSummary[]>();
    for (const s of sessions) if (s.parentSessionId) m.set(s.parentSessionId, [...(m.get(s.parentSessionId) ?? []), s]);
    return m;
  }, [sessions]);
  const topLevel = useMemo(() => sessions.filter((s) => !s.parentSessionId && !s.taskId && !s.trainingRunId && !s.archivedAt), [sessions]);
  const isRunningSession = useMemo(
    () => (s: SessionSummary) => running.has(s.id) || (childrenOf.get(s.id) ?? []).some((k) => running.has(k.id)),
    [running, childrenOf],
  );

  const vitals = useMemo<Vitals>(() => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayTokens = usage?.daily.find((d) => d.date === todayKey);
    const isSubscriptionSpend = !!usage?.hasSubscriptionUsage && (usage?.totalCost ?? 0) === 0;
    type Member = { type: AgentType; running: boolean };
    const members: Member[] = [];
    for (const s of topLevel) {
      if (!isRunningSession(s) && now - s.updatedAt >= 24 * HOUR) continue;
      members.push({ type: classifySession(s, taskBySession.get(s.id)), running: isRunningSession(s) });
    }
    for (const t of tasks) {
      if (t.status !== 'active') continue;
      members.push({ type: classifyAgent({ taskKind: t.kind, taskCondition: t.condition, prompt: t.prompt }), running: !!t.lastSessionId && running.has(t.lastSessionId) });
    }
    const byRole = new Map<string, { type: AgentType; count: number; live: number }>();
    for (const m of members) {
      const e = byRole.get(m.type.role) ?? { type: m.type, count: 0, live: 0 };
      e.count++;
      if (m.running) e.live++;
      byRole.set(m.type.role, e);
    }
    return {
      working: running.size,
      waiting: topLevel.filter((s) => !!pending[s.id]).length,
      automations: tasks.filter((t) => t.status === 'active').length,
      terminals: terminals.filter((t) => t.running).length,
      tokensToday: todayTokens ? todayTokens.input + todayTokens.output : 0,
      spend: isSubscriptionSpend ? 'Included in plan' : formatUSD(usage?.totalCost ?? 0),
      fleet: [...byRole.values()].sort((a, b) => b.count - a.count),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usage, topLevel, tasks, running, pending, terminals, taskBySession, isRunningSession]);

  const openChat = (id: string) => { openChatPane(id); setView('chat'); };
  const openTerminal = (id: string) => { openTerminalPane(id); setView('chat'); };

  // Starting work from the wall keeps you on the wall: the new chat or shell
  // goes straight into the grid rather than switching to the Agent tab.
  const newChatHere = async () => {
    const s = await window.nekko.createSession(activeProjectId ?? undefined);
    useStore.setState((state) => ({ sessions: [summarizeSession(s), ...state.sessions] }));
    setGrid((g) => addCells(g, [{ kind: 'chat', refId: s.id }]));
  };
  const newTerminalHere = async () => {
    const t = await window.nekko.createTerminal({ workspaceId: activeProjectId ?? undefined });
    await refreshTerminals();
    setGrid((g) => addCells(g, [{ kind: 'terminal', refId: t.id }]));
  };

  const insights = grid.insights.show && (
    <InsightsBox
      prefs={grid.insights}
      onPrefs={(next) => setGrid((g) => ({ ...g, insights: next }))}
      usage={usage}
      sessions={sessions}
      providers={providers}
      vitals={vitals}
      onOpenModels={() => setView('models')}
    />
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex w-full flex-col gap-4 px-4 py-5 xl:px-8">
        <GridToolbar grid={grid} setGrid={setGrid} />
        {grid.insights.position === 'top' && insights}
        <CommandGrid
          state={grid}
          setState={setGrid}
          sessions={sessions}
          terminals={terminals}
          running={running}
          pending={pending}
          childrenOf={childrenOf}
          projects={settings?.workspaces ?? []}
          onOpenChat={openChat}
          onOpenTerminal={openTerminal}
          onNewChat={newChatHere}
          onNewTerminal={newTerminalHere}
        />
        <AutomationsBoard tasks={tasks} running={running} now={now} onOpen={openChat} />
        {grid.insights.position === 'bottom' && insights}
      </div>
    </div>
  );
}

/* ---------- toolbar ---------- */

const FILTERS: Array<{ key: GridFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'chat', label: 'Agents' },
  { key: 'terminal', label: 'Terminals' },
];

function GridToolbar({ grid, setGrid }: { grid: CommandGridState; setGrid: (update: (s: CommandGridState) => CommandGridState) => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hover, setHover] = useState<{ cols: number; rows: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [pickerOpen]);

  const fixed = grid.layout.mode === 'fixed' ? grid.layout : null;
  const shown = hover ?? fixed;
  const counts = { chat: grid.cells.filter((c) => c.kind === 'chat').length, terminal: grid.cells.filter((c) => c.kind === 'terminal').length };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <h1 className="text-gradient text-2xl font-semibold">Command Center</h1>
      <span className="text-[12px] text-ink-faint">
        {counts.chat} agent{counts.chat === 1 ? '' : 's'} · {counts.terminal} terminal{counts.terminal === 1 ? '' : 's'} on the wall
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={grid.filter === f.key}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${grid.filter === f.key ? 'bg-surface-2 font-medium text-ink' : 'text-ink-faint hover:text-ink'}`}
              onClick={() => setGrid((g) => ({ ...g, filter: f.key }))}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center rounded-lg border border-line p-0.5" aria-label="Grid layout">
          <button
            className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${!fixed ? 'bg-surface-2 font-medium text-ink' : 'text-ink-faint hover:text-ink'}`}
            title="Fit the windows to the space automatically"
            aria-pressed={!fixed}
            onClick={() => setGrid((g) => ({ ...g, layout: { mode: 'auto' } }))}
          >
            Auto
          </button>
          <div className="relative" ref={pickerRef}>
            <button
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors ${fixed ? 'bg-surface-2 font-medium text-ink' : 'text-ink-faint hover:text-ink'}`}
              title="Pick a fixed number of columns and rows"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((o) => !o)}
            >
              <GridIcon className="h-3.5 w-3.5" />
              <span className="tabular-nums">{fixed ? `${fixed.cols} × ${fixed.rows}` : 'Fixed'}</span>
            </button>
            {pickerOpen && (
              <div className="card absolute right-0 top-9 z-30 p-3 shadow-lg" style={{ background: 'var(--paper)' }} onMouseLeave={() => setHover(null)}>
                <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${GRID_MAX}, 22px)` }} role="grid" aria-label="Columns by rows">
                  {Array.from({ length: GRID_MAX * GRID_MAX }, (_, i) => {
                    const cols = (i % GRID_MAX) + 1, rows = Math.floor(i / GRID_MAX) + 1;
                    const lit = !!shown && cols <= shown.cols && rows <= shown.rows;
                    return (
                      <button
                        key={i}
                        role="gridcell"
                        aria-label={`${cols} columns by ${rows} rows`}
                        className="h-[22px] w-[22px] rounded-[5px] border transition-colors"
                        style={{ borderColor: lit ? 'var(--accent)' : 'var(--line)', background: lit ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent' }}
                        onMouseEnter={() => setHover({ cols, rows })}
                        onFocus={() => setHover({ cols, rows })}
                        onClick={() => { setGrid((g) => ({ ...g, layout: { mode: 'fixed', cols, rows } })); setPickerOpen(false); }}
                      />
                    );
                  })}
                </div>
                <p className="mt-2 text-center text-[12px] tabular-nums text-ink-soft">{shown ? `${shown.cols} × ${shown.rows}` : 'columns × rows'}</p>
              </div>
            )}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-soft" title="Every chat that starts, sub-agents included, joins the wall">
          <Toggle value={grid.autoAdd} onChange={(v) => setGrid((g) => ({ ...g, autoAdd: v }))} label="Auto-add new agents" />
          <span>Auto-add new agents</span>
        </label>
        {!grid.insights.show && (
          <button className="btn btn-outline py-1 text-[12px]" onClick={() => setGrid((g) => ({ ...g, insights: { ...g.insights, show: true } }))}>Show insights</button>
        )}
      </div>
    </div>
  );
}

/* ---------- shared bits ---------- */

function relTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(mo / 12);
  return `${y} yr${y === 1 ? '' : 's'} ago`;
}

/** "in 45s" / "in 12 mins" / "in 3 hrs" / "in 2 days", for automation countdowns. */
function inTime(ms: number): string {
  if (ms <= 0) return 'due now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h} hr${h === 1 ? '' : 's'}${m % 60 ? ` ${m % 60} min` : ''}`;
  const d = Math.round(h / 24);
  if (d < 30) return `in ${d} day${d === 1 ? '' : 's'}`;
  const mo = Math.round(d / 30);
  return `in ${mo} month${mo === 1 ? '' : 's'}`;
}

/* ---------- Automations ---------- */

const TASK_KIND_META: Record<AutomationTask['kind'], { icon: string; label: string }> = {
  scheduled: { icon: '⏰', label: 'Scheduled' },
  recurring: { icon: '🔁', label: 'Recurring' },
  background: { icon: '♾️', label: 'Background' },
};

/** Status resolution for an automation row: running now > next up > paused > done/error. */
function taskState(t: AutomationTask, running: Set<string>, now: number): { label: string; color: string; live: boolean } {
  if (t.lastSessionId && running.has(t.lastSessionId)) return { label: 'running now', color: 'var(--success)', live: true };
  if (t.status === 'active') {
    if (t.nextRunAt) return { label: inTime(t.nextRunAt - now), color: 'var(--warning)', live: false };
    return { label: 'active', color: 'var(--success)', live: false };
  }
  if (t.status === 'paused') return { label: 'paused', color: 'var(--neutral)', live: false };
  if (t.status === 'error') return { label: 'error', color: 'var(--danger)', live: false };
  return { label: 'done', color: 'var(--info)', live: false };
}

/** The automations board: what fired, what's planned next, what's parked. */
function AutomationsBoard({ tasks, running, now, onOpen }: { tasks: AutomationTask[]; running: Set<string>; now: number; onOpen: (id: string) => void }) {
  const rank = (t: AutomationTask) => {
    if (t.lastSessionId && running.has(t.lastSessionId)) return 0;
    if (t.status === 'active') return 1;
    if (t.status === 'paused') return 2;
    if (t.status === 'error') return 3;
    return 4;
  };
  const sorted = [...tasks].sort((a, b) => rank(a) - rank(b) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || b.createdAt - a.createdAt);
  const active = tasks.filter((t) => t.status === 'active').length;

  return (
    <section>
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">Automations</h2>
        <span className="text-[12px] text-ink-faint">{tasks.length === 0 ? 'scheduled, recurring & background work' : `${active} active of ${tasks.length}`}</span>
      </div>
      {sorted.length === 0 ? (
        <EmptyArea className="mt-2.5" art={<AutomationsEmptyArt />} title="Nothing scheduled">
          Open a chat and use its <span className="font-medium text-ink-soft">⚡ Automate</span> menu to run a prompt at a time, repeat it on a schedule, or keep an agent working in the background. They line up here.
        </EmptyArea>
      ) : (
        <PanelList className="mt-2.5">
          {sorted.map((t) => {
            const meta = TASK_KIND_META[t.kind];
            const st = taskState(t, running, now);
            return (
              <div key={t.id} className="group px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[13px]" style={{ background: 'var(--surface-2)' }} title={meta.label}>{meta.icon}</span>
                  <button
                    className="min-w-0 truncate text-left text-[13px] font-medium enabled:hover:text-accent"
                    onClick={() => t.lastSessionId && onOpen(t.lastSessionId)}
                    disabled={!t.lastSessionId}
                    title={t.lastSessionId ? 'Open this automation’s chat' : t.title}
                  >
                    {t.title}
                  </button>
                  <span className="shrink-0 text-[11px] text-ink-faint">{taskCadence(t)}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5 tabular-nums text-[11.5px] font-medium" style={{ color: st.color }}>
                    {st.live && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: st.color }} />}
                    {st.label}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    {t.status !== 'done' && (
                      <button className="btn btn-ghost px-2 py-0.5 text-[11.5px]" onClick={() => window.nekko.runTaskNow(t.id)}>Run now</button>
                    )}
                    {t.status === 'active' ? (
                      <button className="btn btn-ghost px-2 py-0.5 text-[11.5px]" onClick={() => window.nekko.updateTask(t.id, { status: 'paused' })}>Pause</button>
                    ) : t.status === 'paused' ? (
                      <button className="btn btn-ghost px-2 py-0.5 text-[11.5px]" onClick={() => window.nekko.updateTask(t.id, { status: 'active' })}>Resume</button>
                    ) : null}
                    <button className="rounded-sm p-1 text-ink-faint hover:text-red-400" title="Delete automation" onClick={() => window.nekko.deleteTask(t.id)}><TrashIcon className="h-3.5 w-3.5" /></button>
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 pl-[34px] text-[11.5px] text-ink-faint">
                  {t.runCount > 0 && <span className="shrink-0 tabular-nums">{t.runCount} run{t.runCount === 1 ? '' : 's'}{t.lastRunAt ? ` · last ${relTime(now - t.lastRunAt)}` : ''}</span>}
                  {t.lastResult && <span className="min-w-0 truncate text-ink-soft" title={t.lastResult}>{t.lastResult}</span>}
                </div>
              </div>
            );
          })}
        </PanelList>
      )}
    </section>
  );
}
