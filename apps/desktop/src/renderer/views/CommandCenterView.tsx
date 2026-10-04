import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, AutomationTask, PendingInput, SessionSummary, UsageSummary } from '@agent-nekko/shared';
import type { AgentType } from '@agent-nekko/shared';
import { BLOCKED_META, classifyAgent, classifySession, formatUSD, sessionLane, summarizeSession } from '@agent-nekko/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { Toggle } from '../components/primitives/index.js';
import { BoltIcon, ChatIcon, GridIcon, LayoutIcon, PlusIcon, TerminalIcon } from '../icons.js';
import { CommandWall } from '../components/CommandWall.js';
import { InsightsBox, type Vitals } from '../components/InsightsBox.js';
import { AutomationsPane } from '../components/AutomationsPane.js';
import { SHORTCUTS } from '../shortcuts.js';
import { allPanes, isSplit, type PaneKind } from '../layout.js';
import {
  DEFAULT_ASPECT,
  addPane,
  hasPane,
  loadWallState,
  reconcileWall,
  saveWallState,
  tileTree,
  wallPane,
  type CommandWallState,
  type WallFilter,
} from '../commandWall.js';

const HOUR = 60 * 60_000;

/**
 * The Command Center: every agent and terminal as a live window on one wall,
 * arranged in the same split tree the Agent tab uses, with the automations
 * list and the insights box as windows among them. The windows are the same
 * chat and terminal panes the Agent tab shows, so work gets handled here, not
 * just watched; a ribbon above the wall lists everything waiting on you and
 * jumps to it.
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
  const [wall, setWallState] = useState<CommandWallState>(() => loadWallState(typeof localStorage === 'undefined' ? undefined : localStorage));
  const setWall = useCallback((update: (s: CommandWallState) => CommandWallState) => setWallState((s) => update(s)), []);
  useEffect(() => { saveWallState(typeof localStorage === 'undefined' ? undefined : localStorage, wall); }, [wall]);
  // The stage's shape, as the wall measures it, for placing windows nobody
  // pointed at a side for: beside the biggest window, along its longer side.
  const aspectRef = useRef(DEFAULT_ASPECT);
  const onAspect = useCallback((a: number) => { aspectRef.current = a; }, []);
  // Not before both lists have loaded once: reconciling against the empty
  // lists the view mounts with would seed an empty wall and watermark every
  // chat that already exists out of it.
  const [listsReady, setListsReady] = useState(false);
  useEffect(() => {
    if (listsReady) setWallState((w) => reconcileWall(w, sessions, terminals, Date.now(), aspectRef.current));
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
  // which is how it reaches the wall.
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
  // becomes a window here rather than switching to the Agent tab.
  const newChat = async (): Promise<string> => {
    const s = await window.nekko.createSession(activeProjectId ?? undefined);
    useStore.setState((state) => ({ sessions: [summarizeSession(s), ...state.sessions] }));
    return s.id;
  };
  const newTerminal = async (): Promise<string> => {
    const t = await window.nekko.createTerminal({ workspaceId: activeProjectId ?? undefined });
    await refreshTerminals();
    return t.id;
  };
  /** A window from the toolbar, with no side pointed at: beside the biggest window. */
  const addFromToolbar = async (kind: PaneKind, refId?: string) => {
    const ref = refId ?? (kind === 'chat' ? await newChat() : kind === 'terminal' ? await newTerminal() : kind);
    setWall((w) => (hasPane(w.root, kind, ref) ? w : { ...w, root: addPane(w.root, wallPane(kind, ref), aspectRef.current) }));
  };
  const autoArrange = () => setWall((w) => ({ ...w, root: tileTree(allPanes(w.root), aspectRef.current) }));

  // The ribbon's jump: the window is rung once and its composer focused.
  const [flash, setFlash] = useState<{ paneId: string; at: number } | null>(null);
  const goTo = (sessionId: string) => {
    const pane = allPanes(wall.root).find((p) => p.kind === 'chat' && p.refId === sessionId);
    if (pane) setFlash({ paneId: pane.id, at: Date.now() });
    else { setWall((w) => ({ ...w, root: addPane(w.root, wallPane('chat', sessionId), aspectRef.current) })); }
  };
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  const needs = useMemo(
    () => sessions
      .filter((s) => !s.archivedAt && !!pending[s.id])
      .map((s) => ({ session: s, pending: pending[s.id], blocked: sessionLane({ running: false, pending: pending[s.id] }).blocked }))
      .filter((n): n is Need => !!n.blocked),
    [sessions, pending],
  );

  const renderPanel = (kind: 'automations' | 'insights') =>
    kind === 'automations' ? (
      <AutomationsPane tasks={tasks} running={running} now={now} onOpen={openChat} />
    ) : (
      <InsightsBox
        prefs={wall.insights}
        onPrefs={(next) => setWall((w) => ({ ...w, insights: next }))}
        usage={usage}
        sessions={sessions}
        providers={providers}
        vitals={vitals}
        onOpenModels={() => setView('models')}
      />
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-5 xl:px-6">
      <WallToolbar wall={wall} setWall={setWall} sessions={sessions} terminals={terminals} onAdd={addFromToolbar} onAutoArrange={autoArrange} />
      {needs.length > 0 && <NeedsYouRibbon needs={needs} onGo={goTo} />}
      <CommandWall
        state={wall}
        setState={setWall}
        sessions={sessions}
        terminals={terminals}
        running={running}
        pending={pending}
        childrenOf={childrenOf}
        projects={settings?.workspaces ?? []}
        flash={flash}
        onAspect={onAspect}
        onOpenChat={openChat}
        onOpenTerminal={openTerminal}
        onNewChat={newChat}
        onNewTerminal={newTerminal}
        renderPanel={renderPanel}
      />
    </div>
  );
}

/* ---------- the ribbon ---------- */

type Need = { session: SessionSummary; pending: PendingInput; blocked: NonNullable<ReturnType<typeof sessionLane>['blocked']> };

/** What an approval is asking for, in a few words: the command when there is one, else the tool. */
function approvalSummary(p: PendingInput): string | null {
  const call = p.approval?.call as { name?: string; arguments?: unknown } | undefined;
  if (!call) return null;
  const args = call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {};
  const cmd = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : null;
  if (cmd) return cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
  return call.name ?? null;
}

/**
 * Everything waiting on a person, in one line above the wall. Each window
 * already wears its own ring; this is the list for a wall with more windows
 * than fit, with a jump to each.
 */
function NeedsYouRibbon({ needs, onGo }: { needs: Need[]; onGo: (sessionId: string) => void }) {
  return (
    <div className="wall-ribbon" role="region" aria-label="Needs you">
      <span className="wall-ribbon-lead"><span className="h-[7px] w-[7px] animate-pulse rounded-full" style={{ background: 'var(--warning)' }} />Needs you · {needs.length}</span>
      {needs.map(({ session, pending, blocked }) => {
        const what = blocked === 'approval' ? approvalSummary(pending) : null;
        return (
          <span key={session.id} className="wall-ribbon-item">
            <span className="min-w-0 max-w-[28ch] truncate font-medium">{session.title}</span>
            <span className="min-w-0 truncate text-ink-soft">
              {blocked === 'approval' && what ? <>approve <code className="rounded-sm px-1 font-mono text-[11px]" style={{ background: 'var(--surface-2)' }}>{what}</code></> : BLOCKED_META[blocked].label.toLowerCase()}
            </span>
            <button className="wall-ribbon-go" onClick={() => onGo(session.id)} title={`Jump to ${session.title}`}>Go</button>
          </span>
        );
      })}
      <span className="ml-auto text-[11.5px] text-ink-faint">Answer on the window, or jump to it.</span>
    </div>
  );
}

/* ---------- toolbar ---------- */

const FILTERS: Array<{ key: WallFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'chat', label: 'Agents' },
  { key: 'terminal', label: 'Terminals' },
];

function WallToolbar({
  wall,
  setWall,
  sessions,
  terminals,
  onAdd,
  onAutoArrange,
}: {
  wall: CommandWallState;
  setWall: (update: (s: CommandWallState) => CommandWallState) => void;
  sessions: SessionSummary[];
  terminals: import('@agent-nekko/shared').TerminalInfo[];
  onAdd: (kind: PaneKind, refId?: string) => Promise<void>;
  onAutoArrange: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => { if (!addRef.current?.contains(e.target as Node)) setAddOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [addOpen]);

  const panes = allPanes(wall.root);
  const counts = { chat: panes.filter((p) => p.kind === 'chat').length, terminal: panes.filter((p) => p.kind === 'terminal').length };
  const on = (kind: PaneKind, refId: string = kind) => panes.some((p) => p.kind === kind && p.refId === refId);
  const chats = sessions
    .filter((s) => !s.archivedAt && !s.taskId && !s.trainingRunId && !on('chat', s.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  const shells = terminals.filter((t) => !on('terminal', t.id) && !t.agentSessionId).slice(0, 6);
  const run = (kind: PaneKind, refId?: string) => { setAddOpen(false); setBusy(true); void onAdd(kind, refId).finally(() => setBusy(false)); };
  const canArrange = !!wall.root && isSplit(wall.root);

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
              aria-selected={wall.filter === f.key}
              className={`rounded-md px-2.5 py-1 text-[12px] transition-colors ${wall.filter === f.key ? 'bg-surface-2 font-medium text-ink' : 'text-ink-faint hover:text-ink'}`}
              onClick={() => setWall((w) => ({ ...w, filter: f.key }))}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-outline gap-1.5 py-1 text-[12px] disabled:opacity-50"
          title="Re-tile the wall into even rows and columns"
          onClick={onAutoArrange}
          disabled={!canArrange}
        >
          <GridIcon className="h-3.5 w-3.5" /> Auto-arrange
        </button>
        <div className="relative" ref={addRef}>
          <button
            className="btn btn-outline gap-1.5 py-1 text-[12px] disabled:opacity-50"
            onClick={() => setAddOpen((o) => !o)}
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            title="Add an agent, a terminal, a panel, or a chat already running"
          >
            <PlusIcon className="h-3.5 w-3.5" /> {busy ? 'Starting…' : 'Add window'}
          </button>
          {addOpen && (
            <div className="card absolute right-0 top-9 z-30 w-72 max-h-[70vh] overflow-y-auto p-1.5 shadow-lg" style={{ background: 'var(--paper)' }} role="menu">
              <button className="create-row create-row-hero flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left" role="menuitem" onClick={() => run('chat')}>
                <span className="create-tile create-tile-brand"><ChatIcon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">New agent</span>
                  <span className="block text-[11px] text-ink-faint">A fresh chat, right here on the wall</span>
                </span>
                <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd>
              </button>
              <button className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left" role="menuitem" onClick={() => run('terminal')}>
                <span className="create-tile" style={{ color: 'var(--success)' }}><TerminalIcon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold">New terminal</span>
                  <span className="block text-[11px] text-ink-faint">A shell in the active project</span>
                </span>
                <kbd className="kbd">{SHORTCUTS.newTerminal.label}</kbd>
              </button>
              {(!on('automations') || !on('insights')) && (
                <>
                  <p className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Panels</p>
                  {!on('automations') && (
                    <button className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left" role="menuitem" onClick={() => run('automations')}>
                      <BoltIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">Automations</span>
                    </button>
                  )}
                  {!on('insights') && (
                    <button className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left" role="menuitem" onClick={() => run('insights')}>
                      <LayoutIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">Insights</span>
                    </button>
                  )}
                </>
              )}
              {(chats.length > 0 || shells.length > 0) && (
                <>
                  <p className="px-2.5 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Already running</p>
                  {chats.map((s) => (
                    <button key={s.id} className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left" role="menuitem" onClick={() => run('chat', s.id)}>
                      <ChatIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{s.title}</span>
                      {s.parentSessionId && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
                    </button>
                  ))}
                  {shells.map((t) => (
                    <button key={t.id} className="create-row flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left" role="menuitem" onClick={() => run('terminal', t.id)}>
                      <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{t.title}</span>
                      <span className="shrink-0 text-[11px]" style={{ color: t.running ? 'var(--success)' : 'var(--ink-faint)' }}>{t.running ? 'live' : 'exited'}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-soft" title="Every chat that starts, sub-agents included, joins the wall">
          <Toggle value={wall.autoAdd} onChange={(v) => setWall((w) => ({ ...w, autoAdd: v }))} label="Auto-add new agents" />
          <span>Auto-add new agents</span>
        </label>
      </div>
    </div>
  );
}
