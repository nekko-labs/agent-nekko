import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, PendingInput, ProviderConfig, Session, TerminalInfo, UsageSummary, AutomationTask } from '@agent-nekko/shared';
import type { RemoteStatus } from '@agent-nekko/shared';
import { estimateCostUSD, formatUSD, optimizationTips, MODEL_PRICING, taskCadence, classifySession, classifyAgent, isLocalProvider, reduceLiveActivity } from '@agent-nekko/shared';
import type { OptimizationTip, AgentType, LiveActivity } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { Badge, EmptyHint, PanelList } from '../components/primitives/index.js';
import { ServerIcon, PlusIcon, CheckIcon, TerminalIcon, TrashIcon } from '../icons.js';
import { SessionBoard } from '../components/SessionBoard.js';

const HOUR = 60 * 60_000;

export function CommandCenterView() {
  const { sessions, terminals, providers, settings, setView, newChat, openChatPane, openTerminalPane, newTerminal, refreshSessions, refreshTerminals } = useStore();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  // What each chat is waiting on a person for, read from the host so a question
  // asked while this screen was closed is on the board when it opens.
  const [pending, setPending] = useState<Record<string, PendingInput>>({});
  const [, setTick] = useState(0);
  // First-sighting timestamps for in-flight runs, so Now rows can show elapsed.
  const runStarts = useRef(new Map<string, number>());
  /**
   * What each running chat is doing right now, folded from its event stream.
   *
   * A ref rather than state on purpose: text arrives a token at a time, and
   * putting that through `setState` would re-render every card on the board
   * dozens of times a second. The tick below repaints at a readable rate and
   * the cards read the latest fold when they do.
   */
  const activity = useRef(new Map<string, LiveActivity>());
  const now = Date.now();

  useEffect(() => {
    window.nekko.getUsageSummary().then(setUsage);
    refreshSessions();
    refreshTerminals();
    window.nekko.listTasks().then(setTasks).catch(() => setTasks([]));
    window.nekko.pendingInput().then(setPending).catch(() => {});
    const off = window.nekko.onTasksUpdated(setTasks);
    return off;
  }, [refreshSessions, refreshTerminals]);

  // Re-read what is blocked whenever anything might have changed it. The events
  // say what happened, but the host is the one that knows what is *still*
  // outstanding, and a card in the wrong lane is worse than a stale timestamp.
  const refreshPending = () => { window.nekko.pendingInput().then(setPending).catch(() => {}); };

  // Map a task-driven session back to its task, so those agents classify by
  // their task (a recurring "monitor …" task → monitor, not a plain chat).
  const taskBySession = useMemo(() => {
    const m = new Map<string, AutomationTask>();
    for (const t of tasks) if (t.lastSessionId) m.set(t.lastSessionId, t);
    return m;
  }, [tasks]);

  // Track running sessions live; surface freshly spawned sub-agents.
  useEffect(() => {
    const known = new Set(sessions.map((s) => s.id));
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      // Fold every event into the session's live rail before anything else, so
      // a card repainted by the tick below is never a step behind.
      const folded = reduceLiveActivity(activity.current.get(e.sessionId), e, Date.now());
      if (folded) activity.current.set(e.sessionId, folded);
      else activity.current.delete(e.sessionId);

      if (e.type === 'question' || e.type === 'tool_approval_required' || e.type === 'question_resolved' || e.type === 'tool_result') {
        refreshPending();
      }
      if (e.type === 'done' || e.type === 'error') {
        runStarts.current.delete(e.sessionId);
        setRunning((r) => { const n = new Set(r); n.delete(e.sessionId); return n; });
        window.nekko.getUsageSummary().then(setUsage);
        refreshPending();
        refreshSessions(); // pick up the dequeued prompt + final message
      } else {
        if (!runStarts.current.has(e.sessionId)) runStarts.current.set(e.sessionId, Date.now());
        setRunning((r) => (r.has(e.sessionId) ? r : new Set(r).add(e.sessionId)));
      }
      if (!known.has(e.sessionId)) { known.add(e.sessionId); refreshSessions(); }
    });
    return off;
  }, [sessions, refreshSessions]);

  // Tick while work is in flight (elapsed timers and the live step rails), and
  // every 30s regardless (the automation next-run countdowns). Twice a second
  // is fast enough to read as live and slow enough that a streaming reply does
  // not repaint the whole board on every token.
  useEffect(() => {
    if (running.size === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running.size]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const childrenOf = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) if (s.parentSessionId) m.set(s.parentSessionId, [...(m.get(s.parentSessionId) ?? []), s]);
    return m;
  }, [sessions]);

  // Chats the user started directly, excludes sub-agents and task-driven chats
  // (those nest under their parent and live on the Automations board).
  const topLevel = useMemo(() => sessions.filter((s) => !s.parentSessionId && !s.taskId && !s.trainingRunId), [sessions]);
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayTokens = usage?.daily.find((d) => d.date === todayKey);
  const tokensToday = todayTokens ? todayTokens.input + todayTokens.output : 0;
  const isSubscriptionSpend = !!usage?.hasSubscriptionUsage && (usage?.totalCost ?? 0) === 0;

  const isRunningSession = useMemo(
    () => (s: Session) => running.has(s.id) || (childrenOf.get(s.id) ?? []).some((k) => running.has(k.id)),
    [running, childrenOf],
  );

  // Fleet: who's out there, by derived type — running/recent chats + active tasks.
  const fleet = useMemo(() => {
    type Member = { type: AgentType; running: boolean };
    const members: Member[] = [];
    for (const s of topLevel) {
      if (!isRunningSession(s) && now - s.updatedAt >= 24 * HOUR) continue;
      members.push({ type: classifySession(s, taskBySession.get(s.id)), running: isRunningSession(s) });
    }
    for (const t of tasks) {
      if (t.status !== 'active') continue;
      members.push({
        type: classifyAgent({ taskKind: t.kind, taskCondition: t.condition, prompt: t.prompt }),
        running: !!t.lastSessionId && running.has(t.lastSessionId),
      });
    }
    const byRole = new Map<string, { type: AgentType; count: number; live: number }>();
    for (const m of members) {
      const e = byRole.get(m.type.role) ?? { type: m.type, count: 0, live: 0 };
      e.count++;
      if (m.running) e.live++;
      byRole.set(m.type.role, e);
    }
    return [...byRole.values()].sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topLevel, tasks, running, taskBySession, isRunningSession]);

  const openChat = (id: string) => { openChatPane(id); setView('chat'); };
  const openTerminal = (id: string) => { openTerminalPane(id); setView('chat'); };

  const liveTerminals = terminals.filter((t) => t.running).length;
  // Chats parked on a question or an approval. The board has a lane for them,
  // but the strip is what you read first, and "3 waiting on you" is the one
  // number worth interrupting a glance for.
  const waitingOnYou = topLevel.filter((s) => !!pending[s.id]).length;

  return (
    <div className="h-full overflow-y-auto">
      {/* Wide on purpose: the board is three lanes of cards that each carry a
          live step rail and a slice of the conversation, and at the old 72rem
          every one of them truncated mid-sentence. The cap is high enough to
          give a lane real width on a big display, and still centres on one. */}
      <div className="mx-auto w-full max-w-[1760px] px-6 py-8 xl:px-10">
        <div className="flex items-center justify-between">
          <h1 className="text-gradient text-2xl font-semibold">Command Center</h1>
          <div className="flex gap-2">
            <button className="btn btn-outline" onClick={() => { newTerminal(); }}><TerminalIcon className="h-4 w-4" /> Terminal</button>
            <button className="btn btn-primary" onClick={() => { newChat(); }}><PlusIcon className="h-4 w-4" /> New chat</button>
          </div>
        </div>

        {/* The monitor strip: the whole machine's vitals in one quiet line. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-line py-2.5 text-[12px] text-ink-faint">
          <Stat live={running.size > 0} value={running.size} label={running.size === 1 ? 'agent working' : 'agents working'} />
          <StatDivider />
          <Stat value={waitingOnYou} label="waiting on you" tone={waitingOnYou > 0 ? 'var(--warning)' : undefined} />
          <StatDivider />
          <Stat value={tasks.filter((t) => t.status === 'active').length} label="automations active" />
          <StatDivider />
          <Stat value={liveTerminals} label={liveTerminals === 1 ? 'terminal live' : 'terminals live'} />
          <StatDivider />
          <Stat value={tokensToday.toLocaleString()} label="tokens today" />
          <StatDivider />
          <Stat value={isSubscriptionSpend ? 'Included in plan' : formatUSD(usage?.totalCost ?? 0)} label="est. spend" />
          {/* The fleet, by derived role. It used to sit in the "Now" heading;
              the strip is where the other at-a-glance counts already live. */}
          {fleet.length > 0 && (
            <span className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-1">
              {fleet.map((g) => (
                <span
                  key={g.type.role}
                  className="flex items-center gap-1"
                  title={`${g.count} ${g.type.label}${g.count === 1 ? '' : 's'}${g.live > 0 ? `, ${g.live} working` : ''}`}
                >
                  <span>{g.type.icon}</span>
                  <span className="tabular-nums">{g.live > 0 ? `${g.live}/${g.count}` : g.count}</span>
                </span>
              ))}
            </span>
          )}
        </div>

        {/* SESSIONS — every chat as a card, in the lane its state puts it in.
            This is where the work gets handled: answer, approve, reply, stop.
            It absorbed the old "Now" list, which only ever said which of these
            were running and could not say which were waiting on the user. */}
        <SessionBoard
          sessions={topLevel}
          tasks={tasks}
          providers={providers}
          usage={usage}
          running={running}
          pending={pending}
          childrenOf={childrenOf}
          runStarts={runStarts.current}
          activity={activity.current}
          now={now}
          onOpen={openChat}
          onRefresh={() => { refreshSessions(); refreshPending(); }}
          onNewChat={newChat}
        />

        {/* AUTOMATIONS — running, planned (next up), paused, finished. */}
        <AutomationsBoard tasks={tasks} running={running} now={now} onOpen={openChat} />

        {/* TERMINALS */}
        {terminals.length > 0 && (
          <section className="mt-7">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[15px] font-semibold">Terminals</h2>
              <span className="text-[12px] text-ink-faint">{liveTerminals > 0 ? `${liveTerminals} live` : 'none live'}</span>
            </div>
            <PanelList className="mt-2.5">
              {terminals.map((t) => (
                <TerminalRow key={t.id} term={t} workspaceName={settings?.workspaces?.find((w) => w.id === t.workspaceId)?.name} onOpen={openTerminal} />
              ))}
            </PanelList>
          </section>
        )}

        {/* INSIGHTS — analytics behind one segmented control, out of the way. */}
        <InsightsSection usage={usage} sessions={sessions} providers={providers} onOpenModels={() => setView('models')} />
      </div>
    </div>
  );
}

/* ---------- monitor strip ---------- */

function Stat({ value, label, live, tone }: { value: number | string; label: string; live?: boolean; tone?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      {live != null && (
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse' : ''}`} style={{ background: live ? 'var(--success)' : 'var(--ink-faint)' }} />
      )}
      <span className="tabular-nums font-semibold text-ink" style={tone ? { color: tone } : undefined}>{value}</span>
      <span style={tone ? { color: tone } : undefined}>{label}</span>
    </span>
  );
}

function StatDivider() {
  return <span aria-hidden className="h-3 w-px" style={{ background: 'var(--line)' }} />;
}

/* ---------- shared bits ---------- */

function relTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** "in 45s" / "in 12m" / "in 3h" / "in 2d" — for automation countdowns. */
function inTime(ms: number): string {
  if (ms <= 0) return 'due now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `in ${Math.round(h / 24)}d`;
}

/** "38s" / "4m 12s" / "1h 08m" — elapsed time on a working run. */
function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
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
    <section className="mt-7">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">Automations</h2>
        <span className="text-[12px] text-ink-faint">{tasks.length === 0 ? 'scheduled, recurring & background work' : `${active} active of ${tasks.length}`}</span>
      </div>
      {sorted.length === 0 ? (
        <EmptyHint className="mt-2.5">
          No automations yet. Open a chat and use the <span className="font-medium text-ink-soft">⚡ Automate</span> menu to schedule a run, repeat it, or keep an agent working in the background.
        </EmptyHint>
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

/* ---------- Terminals ---------- */

function TerminalRow({ term, workspaceName, onOpen }: { term: TerminalInfo; workspaceName?: string; onOpen: (id: string) => void }) {
  return (
    <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2" onClick={() => onOpen(term.id)}>
      <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 shrink-0 text-[13px] font-medium">{term.title}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">{term.cwd}</span>
      {workspaceName && <span className="hidden shrink-0 text-[11.5px] text-ink-faint sm:inline">{workspaceName}</span>}
      <span className="shrink-0 tabular-nums text-[11.5px] font-medium" style={{ color: term.running ? 'var(--success)' : 'var(--ink-faint)' }}>
        {term.running ? 'live' : 'exited'}
      </span>
    </button>
  );
}

/* ---------- Insights (segmented analytics) ---------- */

type InsightTab = 'optimize' | 'cost' | 'usage' | 'services';

function InsightsSection({
  usage, sessions, providers, onOpenModels,
}: {
  usage: UsageSummary | null; sessions: Session[]; providers: ProviderConfig[]; onOpenModels: () => void;
}) {
  const tips = useMemo(() => optimizationTips({ usage, sessions, providers }), [usage, sessions, providers]);
  const [tab, setTab] = useState<InsightTab>(tips.length > 0 ? 'optimize' : 'cost');
  const TABS: Array<{ key: InsightTab; label: string }> = [
    { key: 'optimize', label: 'Optimize' },
    { key: 'cost', label: 'Cost' },
    { key: 'usage', label: 'Usage' },
    { key: 'services', label: 'Services' },
  ];
  const DESC: Record<InsightTab, string> = {
    optimize: 'Ways to cut token spend and run leaner, from your own usage.',
    cost: 'Spend by agent and model, monthly actuals + projection. Local models are free.',
    usage: 'Tokens over time and by model.',
    services: 'Model providers, MCP servers, and the remote relay, with live status.',
  };
  return (
    <section className="mt-9 border-t border-line pt-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[15px] font-semibold">Insights</h2>
        <div className="ml-auto inline-flex rounded-lg border border-line p-0.5" role="tablist" aria-label="Insights">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`rounded-md px-3 py-1 text-[12px] transition-colors ${tab === t.key ? 'bg-surface-2 font-medium text-ink' : 'text-ink-faint hover:text-ink'}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.key === 'optimize' && tips.length > 0 && <span className="ml-1.5 tabular-nums text-[10.5px] text-accent">{tips.length}</span>}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">{DESC[tab]}</p>
      <div className="mt-3">
        {tab === 'optimize' && <OptimizePanel tips={tips} onOpenModels={onOpenModels} />}
        {tab === 'cost' && <CostPanel usage={usage} sessions={sessions} providers={providers} />}
        {tab === 'usage' && <UsagePanel usage={usage} />}
        {tab === 'services' && <ServicesPanel providers={providers} usage={usage} />}
      </div>
    </section>
  );
}

const TIP_STYLE: Record<OptimizationTip['severity'], { color: string; icon: string; label: string }> = {
  warn: { color: 'var(--warning)', icon: '!', label: 'Heads up' },
  suggest: { color: 'var(--success)', icon: '↳', label: 'Suggestion' },
  info: { color: 'var(--info)', icon: 'i', label: 'Insight' },
};

function OptimizePanel({ tips, onOpenModels }: { tips: OptimizationTip[]; onOpenModels: () => void }) {
  const totalSaving = tips.reduce((s, t) => s + (t.saving ?? 0), 0);
  if (tips.length === 0) {
    return <EmptyHint>No tips right now, your usage looks lean.</EmptyHint>;
  }
  return (
    <>
      {totalSaving > 0.01 && <p className="mb-2 text-[12px] text-ink-soft">~{formatUSD(totalSaving)} potential savings</p>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {tips.map((t) => {
          const st = TIP_STYLE[t.severity];
          return (
            <div key={t.id} className="card flex gap-3 p-4">
              <span
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ background: st.color }}
                title={st.label}
              >
                {st.icon}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">{t.title}</span>
                  {t.saving && t.saving > 0.01 && <span className="chip">~{formatUSD(t.saving)}</span>}
                </div>
                <p className="mt-0.5 text-[12px] text-ink-soft">{t.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
      <button className="mt-3 text-[12px] text-accent hover:underline" onClick={onOpenModels}>
        Manage models &amp; providers →
      </button>
    </>
  );
}

function UsagePanel({ usage }: { usage: UsageSummary | null }) {
  if (!usage) return null;
  const max = Math.max(1, ...usage.daily.map((d) => d.input + d.output));
  return (
    <div className="card p-5">
      <div className="flex gap-6 text-[13px]">
        <div><span className="text-ink-faint">Input</span> <span className="font-semibold tabular-nums">{usage.totalInput.toLocaleString()}</span></div>
        <div><span className="text-ink-faint">Output</span> <span className="font-semibold tabular-nums">{usage.totalOutput.toLocaleString()}</span></div>
      </div>
      {usage.daily.length > 0 ? (
        <div className="mt-4 flex h-32 items-end gap-1">
          {usage.daily.slice(-30).map((d) => (
            <div key={d.date} className="flex flex-1 flex-col justify-end" title={`${d.date}: ${(d.input + d.output).toLocaleString()} tok`}>
              <div className="rounded-t" style={{ height: `${((d.input + d.output) / max) * 100}%`, background: 'var(--accent)', minHeight: 2 }} />
            </div>
          ))}
        </div>
      ) : (
        <ChartEmpty message="No usage recorded yet, start a chat to see token analytics here." />
      )}
      {Object.keys(usage.byModel).length > 0 && (
        <div className="mt-4 space-y-1">
          {Object.entries(usage.byModel).map(([model, v]) => {
            const cost = v.cost ?? estimateCostUSD(model, v.input, v.output);
            const costLabel = cost > 0 ? formatUSD(cost) : v.subscription ? 'Included in plan' : formatUSD(0);
            return (
              <div key={model} className="flex justify-between gap-3 text-[12px]">
                <span className="truncate font-mono text-ink-soft" title={v.subscription ? 'Included in a subscription plan' : undefined}>{model}</span>
                <span className="shrink-0 tabular-nums text-ink-faint" title={v.subscription ? 'No per-token API cost for subscription usage' : undefined}>
                  {(v.input + v.output).toLocaleString()} tok
                  <span className="ml-2 text-ink">{costLabel}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A friendly skeleton placeholder for a chart with no data yet. */
function ChartEmpty({ message, bars = 12 }: { message: string; bars?: number }) {
  // Deterministic pseudo-random heights so the skeleton looks like a chart.
  const heights = Array.from({ length: bars }, (_, i) => 30 + ((i * 37) % 60));
  return (
    <div className="mt-4 rounded-xl border border-dashed border-line p-4">
      <div className="flex h-24 items-end gap-1 opacity-40">
        {heights.map((h, i) => (
          <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: 'var(--ink-faint)' }} />
        ))}
      </div>
      <p className="mt-3 text-center text-[12px] text-ink-faint">{message}</p>
    </div>
  );
}

/** Cost breakdowns: monthly actual + projection, per-agent, per-model, and pricing. */
function CostPanel({ usage, sessions, providers }: { usage: UsageSummary | null; sessions: Session[]; providers: ProviderConfig[] }) {
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Chat';
  const hasData = !!usage && ((usage.totalCost ?? 0) > 0.0000001 || !!usage.hasSubscriptionUsage);

  // This month's actual + a simple linear projection to month-end.
  const monthKey = new Date().toISOString().slice(0, 7);
  const monthDaily = (usage?.daily ?? []).filter((d) => d.date.startsWith(monthKey));
  const monthActual = monthDaily.reduce((s, d) => s + (d.cost ?? 0), 0);
  const dayOfMonth = new Date().getDate();
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  const projected = dayOfMonth > 0 ? (monthActual / dayOfMonth) * daysInMonth : monthActual;

  const topAgents = useMemo(() => {
    return Object.entries(usage?.bySessionCost ?? {})
      .filter(([, c]) => c > 0.0000001)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [usage]);
  const maxAgent = Math.max(0.0001, ...topAgents.map(([, c]) => c));

  const recentCost = (usage?.daily ?? []).slice(-30);
  const maxDayCost = Math.max(0.0001, ...recentCost.map((d) => d.cost ?? 0));

  const subscriptionChats = useMemo(() => {
    if (!usage?.hasSubscriptionUsage) return [] as Session[];
    return sessions.filter((s) => {
      const t = usage.bySession[s.id];
      const p = providers.find((p) => p.id === s.providerId);
      return p?.auth === 'subscription' && t && t.input + t.output > 0;
    });
  }, [usage, sessions, providers]);
  const subscriptionTokens = useMemo(() =>
    subscriptionChats.reduce((n, s) => n + (usage?.bySession[s.id]?.input ?? 0) + (usage?.bySession[s.id]?.output ?? 0), 0),
  [subscriptionChats, usage]);

  return (
    <>
      {!hasData ? (
        <ChartEmpty message="No spend yet. Once you run a cloud model, monthly spend, projections, and per-agent costs show up here." />
      ) : (
        <>
          {/* Monthly actual + projection, in the monitor strip's language. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-ink-faint">
            <Stat value={formatUSD(monthActual)} label={`this month (${dayOfMonth}/${daysInMonth} days)`} />
            <StatDivider />
            <Stat value={formatUSD(projected)} label="projected month-end" />
            <StatDivider />
            <Stat value={formatUSD(usage!.totalCost ?? 0)} label="all time" />
            <span className="ml-auto" title="Estimated from published provider list prices; local models are $0.">est. · list prices</span>
          </div>

          {/* Daily spend chart */}
          <div className="card mt-3 p-4">
            <div className="text-[12px] font-medium">Daily spend (last 30 days)</div>
            <div className="mt-3 flex h-24 items-end gap-1">
              {recentCost.map((d) => (
                <div key={d.date} className="flex flex-1 flex-col justify-end" title={`${d.date}: ${formatUSD(d.cost ?? 0)}`}>
                  <div className="rounded-t" style={{ height: `${((d.cost ?? 0) / maxDayCost) * 100}%`, background: 'var(--warning)', minHeight: (d.cost ?? 0) > 0 ? 2 : 0 }} />
                </div>
              ))}
            </div>
          </div>

          {/* Per-agent breakdown */}
          {topAgents.length > 0 && (
            <div className="card mt-3 p-4">
              <div className="text-[12px] font-medium">By agent</div>
              <div className="mt-2 space-y-2">
                {topAgents.map(([sid, cost]) => (
                  <div key={sid}>
                    <div className="flex justify-between gap-3 text-[12px]">
                      <span className="truncate text-ink-soft">{titleOf(sid)}</span>
                      <span className="shrink-0 tabular-nums text-ink">{formatUSD(cost)}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                      <div className="h-full rounded-full" style={{ width: `${(cost / maxAgent) * 100}%`, background: 'var(--accent)' }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {subscriptionChats.length > 0 && topAgents.length === 0 && (
            <div className="card mt-3 p-4">
              <div className="text-[12px] font-medium">By agent</div>
              <div className="mt-2 text-[12px] text-ink-soft">
                {subscriptionChats.length} chat{subscriptionChats.length === 1 ? '' : 's'} ran on a subscription plan ({subscriptionTokens.toLocaleString()} tok). No API spend to show.
              </div>
            </div>
          )}
        </>
      )}

      {/* Pricing reference, token/$ estimates */}
      <details className="card mt-3 p-4">
        <summary className="cursor-pointer text-[12px] font-medium">Token pricing reference (USD per 1M tokens)</summary>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 md:grid-cols-3">
          {MODEL_PRICING.map((p) => (
            <div key={p.match} className="flex justify-between gap-2 text-[11.5px]">
              <span className="font-mono text-ink-soft">{p.match}</span>
              <span className="tabular-nums text-ink-faint">in ${p.input} · out ${p.output}</span>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">Published list prices, matched by model id. Estimates only, your billed amount may differ. Local models (Ollama / LM Studio / vLLM) and subscription providers (Claude / ChatGPT plans) cost $0.</p>
      </details>
    </>
  );
}

function ServicesPanel({ providers, usage }: { providers: ProviderConfig[]; usage: UsageSummary | null }) {
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [mcp, setMcp] = useState<import('@agent-nekko/shared').McpServerStatus[]>([]);
  useEffect(() => { window.nekko.getRemoteStatus().then(setRemote).catch(() => setRemote(null)); }, []);
  useEffect(() => { window.nekko.getMcpStatus().then(setMcp).catch(() => setMcp([])); }, []);
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <RemoteCard remote={remote} />
      {providers.map((p) => (
        <WorkerCard key={p.id} provider={p} tokens={usage?.byProvider[p.id]} />
      ))}
      {mcp.map((m) => (
        <div key={m.id} className="card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-base">🔌</span>
              <span className="text-[13px] font-medium">{m.name}</span>
              <span className="chip">MCP</span>
            </div>
            <StatusPill state={m.connected ? 'online' : 'offline'} />
          </div>
          <p className="mt-2 text-[12px] text-ink-faint">
            {m.connected ? `${m.tools.length} tool${m.tools.length === 1 ? '' : 's'} available` : m.error ?? 'Not connected'}
          </p>
        </div>
      ))}
      {providers.length === 0 && mcp.length === 0 && (
        <div className="card p-4 text-[12px] text-ink-faint">No model providers yet, add one in Model Providers.</div>
      )}
    </div>
  );
}

function WorkerCard({ provider, tokens }: { provider: ProviderConfig; tokens?: { input: number; output: number } }) {
  const [state, setState] = useState<'checking' | 'online' | 'offline'>('checking');
  useEffect(() => {
    window.nekko.testProvider(provider.id).then((r) => setState(r.ok ? 'online' : 'offline')).catch(() => setState('offline'));
  }, [provider.id]);
  const total = tokens ? tokens.input + tokens.output : 0;
  const isLocal = isLocalProvider(provider.kind);
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ServerIcon className="h-4 w-4 text-ink-faint" />
          <span className="text-[13px] font-medium">{provider.label}</span>
          <span className="chip">{isLocal ? 'local' : 'cloud'}</span>
        </div>
        <StatusPill state={state} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[12px] text-ink-faint">
        <span className="font-mono">{provider.baseUrl}</span>
        <span className="tabular-nums">{total.toLocaleString()} tok</span>
      </div>
    </div>
  );
}

function RemoteCard({ remote }: { remote: RemoteStatus | null }) {
  const online = !!remote?.enabled;
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">📱</span>
          <span className="text-[13px] font-medium">Remote relay</span>
        </div>
        <StatusPill state={online ? 'online' : 'offline'} onlineLabel="enabled" offlineLabel="off" />
      </div>
      <p className="mt-2 text-[12px] text-ink-faint">
        {online ? 'Your phone can reach this machine’s model over an encrypted relay.' : 'Enable in Settings → Remote access to drive your local model from anywhere.'}
      </p>
    </div>
  );
}

function StatusPill({ state, onlineLabel = 'online', offlineLabel = 'offline' }: { state: 'checking' | 'online' | 'offline'; onlineLabel?: string; offlineLabel?: string }) {
  if (state === 'checking') return <span className="chip">checking…</span>;
  const online = state === 'online';
  return (
    <Badge tone={online ? 'success' : 'neutral'} variant="solid">
      {online && <CheckIcon className="h-3 w-3" />} {online ? onlineLabel : offlineLabel}
    </Badge>
  );
}
