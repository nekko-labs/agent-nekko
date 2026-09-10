import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, ProviderConfig, Session, TerminalInfo, UsageSummary, AutomationTask } from '@agent-nekko/shared';
import type { RemoteStatus } from '@agent-nekko/shared';
import { estimateCostUSD, formatUSD, optimizationTips, MODEL_PRICING, taskCadence, classifySession, classifyAgent, isLocalProvider } from '@agent-nekko/shared';
import type { OptimizationTip, AgentType } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { Badge, EmptyHint, PanelList } from '../components/primitives/index.js';
import { ChatIcon, ServerIcon, PlusIcon, CheckIcon, TerminalIcon, RobotIcon, TrashIcon } from '../icons.js';

const HOUR = 60 * 60_000;

export function CommandCenterView() {
  const { sessions, terminals, providers, settings, setView, newChat, openChatPane, openTerminalPane, newTerminal, refreshSessions, refreshTerminals } = useStore();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [, setTick] = useState(0);
  // First-sighting timestamps for in-flight runs, so Now rows can show elapsed.
  const runStarts = useRef(new Map<string, number>());
  const now = Date.now();

  useEffect(() => {
    window.kotrain.getUsageSummary().then(setUsage);
    refreshSessions();
    refreshTerminals();
    window.kotrain.listTasks().then(setTasks).catch(() => setTasks([]));
    const off = window.kotrain.onTasksUpdated(setTasks);
    return off;
  }, [refreshSessions, refreshTerminals]);

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
    const off = window.kotrain.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'done' || e.type === 'error') {
        runStarts.current.delete(e.sessionId);
        setRunning((r) => { const n = new Set(r); n.delete(e.sessionId); return n; });
        window.kotrain.getUsageSummary().then(setUsage);
        refreshSessions(); // pick up the dequeued prompt + final message
      } else {
        if (!runStarts.current.has(e.sessionId)) runStarts.current.set(e.sessionId, Date.now());
        setRunning((r) => (r.has(e.sessionId) ? r : new Set(r).add(e.sessionId)));
      }
      if (!known.has(e.sessionId)) { known.add(e.sessionId); refreshSessions(); }
    });
    return off;
  }, [sessions, refreshSessions]);

  // Tick once a second while work is in flight (elapsed timers), and every 30s
  // regardless (the automation next-run countdowns).
  useEffect(() => {
    if (running.size === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
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

  // Now: everything actually working this second — running chats plus live
  // automation fires (task-driven sessions are excluded from topLevel).
  const nowChats = useMemo(
    () => topLevel.filter(isRunningSession).sort((a, b) => b.updatedAt - a.updatedAt),
    [topLevel, isRunningSession],
  );
  const liveTasks = useMemo(() => tasks.filter((t) => !!t.lastSessionId && running.has(t.lastSessionId!)), [tasks, running]);

  // Everything else, one flat most-recent-first list.
  const restChats = useMemo(
    () => topLevel.filter((s) => !isRunningSession(s)).sort((a, b) => b.updatedAt - a.updatedAt),
    [topLevel, isRunningSession],
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-8 py-8">
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
          <Stat value={tasks.filter((t) => t.status === 'active').length} label="automations active" />
          <StatDivider />
          <Stat value={liveTerminals} label={liveTerminals === 1 ? 'terminal live' : 'terminals live'} />
          <StatDivider />
          <Stat value={tokensToday.toLocaleString()} label="tokens today" />
          <StatDivider />
          <Stat value={isSubscriptionSpend ? 'Included in plan' : formatUSD(usage?.totalCost ?? 0)} label="est. spend" />
        </div>

        {/* NOW — what is being worked on this second. */}
        <section className="mt-7">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[15px] font-semibold">Now</h2>
            <span className="text-[12px] text-ink-faint">what your agents are doing</span>
            {fleet.length > 0 && (
              <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                {fleet.map((g) => (
                  <span key={g.type.role} className="flex items-center gap-1" title={`${g.count} ${g.type.label}${g.count === 1 ? '' : 's'}${g.live > 0 ? `, ${g.live} working` : ''}`}>
                    <span>{g.type.icon}</span>
                    <span className="tabular-nums">{g.live > 0 ? `${g.live}/${g.count}` : g.count}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
          {nowChats.length === 0 && liveTasks.length === 0 ? (
            <EmptyHint className="mt-2.5">
              Nothing working right now. <button className="text-accent hover:underline" onClick={() => newChat()}>Start a chat</button>, or run an automation below.
            </EmptyHint>
          ) : (
            <PanelList className="mt-2.5">
              {nowChats.map((s) => (
                <NowRow
                  key={s.id}
                  session={s}
                  agentType={classifySession(s, taskBySession.get(s.id))}
                  provider={providers.find((p) => p.id === s.providerId)}
                  childrenOf={childrenOf}
                  running={running}
                  tokens={usage?.bySession[s.id]}
                  startedAt={runStarts.current.get(s.id)}
                  now={now}
                  onOpen={openChat}
                  onRefresh={refreshSessions}
                />
              ))}
              {liveTasks.map((t) => {
                const s = sessions.find((x) => x.id === t.lastSessionId);
                return s ? (
                  <NowRow
                    key={t.id}
                    session={s}
                    task={t}
                    agentType={classifyAgent({ taskKind: t.kind, taskCondition: t.condition, prompt: t.prompt })}
                    provider={providers.find((p) => p.id === s.providerId)}
                    childrenOf={childrenOf}
                    running={running}
                    tokens={usage?.bySession[s.id]}
                    startedAt={runStarts.current.get(s.id)}
                    now={now}
                    onOpen={openChat}
                    onRefresh={refreshSessions}
                  />
                ) : null;
              })}
            </PanelList>
          )}
        </section>

        {/* AUTOMATIONS — running, planned (next up), paused, finished. */}
        <AutomationsBoard tasks={tasks} running={running} now={now} onOpen={openChat} />

        {/* SESSIONS — every other chat, compact and scannable. */}
        <SessionsList sessions={restChats} providers={providers} usage={usage} now={now} onOpen={openChat} onNewChat={newChat} />

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

function Stat({ value, label, live }: { value: number | string; label: string; live?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {live != null && (
        <span className={`h-1.5 w-1.5 rounded-full ${live ? 'animate-pulse' : ''}`} style={{ background: live ? 'var(--success)' : 'var(--ink-faint)' }} />
      )}
      <span className="tabular-nums font-semibold text-ink">{value}</span>
      <span>{label}</span>
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

/** Count every descendant sub-agent under a session (the whole subtree). */
function countDescendants(id: string, childrenOf: Map<string, Session[]>): number {
  const kids = childrenOf.get(id) ?? [];
  return kids.reduce((n, k) => n + 1 + countDescendants(k.id, childrenOf), 0);
}

/** Recursive sub-agent tree, the swarm under one agent, nested by parentage. */
function SubAgentTree({
  parentId, childrenOf, running, onOpen, depth = 0,
}: {
  parentId: string; childrenOf: Map<string, Session[]>; running: Set<string>;
  onOpen: (id: string) => void; depth?: number;
}) {
  const kids = childrenOf.get(parentId) ?? [];
  if (kids.length === 0) return null;
  return (
    <div className={depth > 0 ? 'ml-3 border-l border-line pl-2' : 'space-y-0.5'}>
      {kids.map((k) => {
        const live = running.has(k.id);
        const grandkids = countDescendants(k.id, childrenOf);
        return (
          <div key={k.id}>
            <button
              className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] hover:bg-surface-2"
              onClick={() => onOpen(k.id)}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${live ? 'animate-pulse bg-accent' : 'bg-ink-faint'}`} />
              <span className="min-w-0 flex-1 truncate text-ink-soft">{k.title}</span>
              {grandkids > 0 && <span className="shrink-0 text-[10px] text-ink-faint">{grandkids}↳</span>}
              {live && <span className="shrink-0 text-[10px] text-accent">live</span>}
            </button>
            <SubAgentTree parentId={k.id} childrenOf={childrenOf} running={running} onOpen={onOpen} depth={depth + 1} />
          </div>
        );
      })}
    </div>
  );
}

/** A small pill for an agent's derived type (code-review bot, monitor, …). */
function AgentTypeBadge({ type }: { type: AgentType }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ background: 'var(--surface-2)', color: type.color }}
      title={`Agent type: ${type.label}`}
    >
      <span>{type.icon}</span>
      {type.label}
    </span>
  );
}

/* ---------- Now ---------- */

/** One in-flight run: who, on what, for how long, doing what, with the queue
 *  and swarm underneath and Stop/Open in hand. */
function NowRow({
  session, task, agentType, provider, childrenOf, running, tokens, startedAt, now, onOpen, onRefresh,
}: {
  session: Session; task?: AutomationTask; agentType: AgentType; provider?: ProviderConfig;
  childrenOf: Map<string, Session[]>; running: Set<string>; tokens?: { input: number; output: number };
  startedAt?: number; now: number; onOpen: (id: string) => void; onRefresh: () => void;
}) {
  const msgs = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  const tok = tokens ? tokens.input + tokens.output : 0;
  const swarmSize = countDescendants(session.id, childrenOf);
  const liveSwarm = (function tally(id): number {
    return (childrenOf.get(id) ?? []).reduce((n, k) => n + (running.has(k.id) ? 1 : 0) + tally(k.id), 0);
  })(session.id);

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2.5">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ background: 'var(--success)' }} />
        <button className="min-w-0 truncate text-left text-[13.5px] font-semibold hover:text-accent" onClick={() => onOpen(session.id)} title={task ? `${task.title} (automation)` : session.title}>
          {task ? task.title : session.title}
        </button>
        <AgentTypeBadge type={agentType} />
        <span className="ml-auto shrink-0 tabular-nums text-[11.5px] font-medium" style={{ color: 'var(--success)' }}>
          {startedAt ? `working ${elapsed(now - startedAt)}` : 'working…'}
        </span>
        <button className="btn btn-outline shrink-0 px-2.5 py-1 text-[12px]" onClick={() => window.kotrain.abortChat(session.id)}>Stop</button>
        <button className="btn btn-ghost shrink-0 px-2.5 py-1 text-[12px]" onClick={() => onOpen(session.id)}>Open →</button>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px] text-[11.5px] text-ink-faint">
        <span>{provider?.label ?? 'no model'}{session.modelId ? ` · ${session.modelId}` : ''}</span>
        <span>· {msgs.length} msg{msgs.length === 1 ? '' : 's'}</span>
        {tok > 0 && <span>· {tok.toLocaleString()} tok</span>}
        {task && <span>· {taskCadence(task)}</span>}
      </div>
      {lastAssistant && (
        <p className="mt-1.5 line-clamp-2 pl-[18px] text-[12px] text-ink-soft">{lastAssistant.content.slice(0, 200)}</p>
      )}
      {(session.queue?.length ?? 0) > 0 && (
        <div className="mt-2 pl-[18px]">
          <div className="mb-1 text-[10.5px] uppercase tracking-wide text-ink-faint">up next · {session.queue!.length} queued</div>
          <div className="space-y-0.5">
            {session.queue!.map((q, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className="shrink-0 tabular-nums text-[10px] text-ink-faint">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-ink-soft" title={q}>{q}</span>
                <button
                  className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-red-400"
                  title="Remove from queue"
                  onClick={async () => { await window.kotrain.dequeuePrompt(session.id, i); onRefresh(); }}
                >
                  <TrashIcon className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {swarmSize > 0 && (
        <div className="mt-2 pl-[18px]">
          <div className="mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wide text-ink-faint">
            <RobotIcon className="h-3.5 w-3.5" /> swarm · {swarmSize} agent{swarmSize === 1 ? '' : 's'}
            {liveSwarm > 0 && <span className="text-accent">· {liveSwarm} live</span>}
          </div>
          <SubAgentTree parentId={session.id} childrenOf={childrenOf} running={running} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
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
                      <button className="btn btn-ghost px-2 py-0.5 text-[11.5px]" onClick={() => window.kotrain.runTaskNow(t.id)}>Run now</button>
                    )}
                    {t.status === 'active' ? (
                      <button className="btn btn-ghost px-2 py-0.5 text-[11.5px]" onClick={() => window.kotrain.updateTask(t.id, { status: 'paused' })}>Pause</button>
                    ) : t.status === 'paused' ? (
                      <button className="btn btn-ghost px-2 py-0.5 text-[11.5px]" onClick={() => window.kotrain.updateTask(t.id, { status: 'active' })}>Resume</button>
                    ) : null}
                    <button className="rounded-sm p-1 text-ink-faint hover:text-red-400" title="Delete automation" onClick={() => window.kotrain.deleteTask(t.id)}><TrashIcon className="h-3.5 w-3.5" /></button>
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

/* ---------- Sessions ---------- */

/** Everything not in flight: one compact, scannable row per chat. */
function SessionsList({
  sessions, providers, usage, now, onOpen, onNewChat,
}: {
  sessions: Session[]; providers: ProviderConfig[]; usage: UsageSummary | null; now: number;
  onOpen: (id: string) => void; onNewChat: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const CAP = 10;
  const shown = showAll ? sessions : sessions.slice(0, CAP);
  return (
    <section className="mt-7">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">Sessions</h2>
        <span className="text-[12px] text-ink-faint">recent chats, most recent first</span>
      </div>
      {sessions.length === 0 ? (
        <EmptyHint className="mt-2.5">
          No chats yet. <button className="text-accent hover:underline" onClick={onNewChat}>Start a chat</button> to kick one off.
        </EmptyHint>
      ) : (
        <PanelList className="mt-2.5">
          {shown.map((s) => {
            const msgs = s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
            const t = usage?.bySession[s.id];
            const tok = t ? t.input + t.output : 0;
            const provider = providers.find((p) => p.id === s.providerId);
            return (
              <button key={s.id} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-2" onClick={() => onOpen(s.id)}>
                <ChatIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.title}</span>
                {s.incognito && <span className="shrink-0 text-[11px]" title="Incognito">🕶</span>}
                <span className="hidden shrink-0 text-[11.5px] text-ink-faint sm:inline">{s.modelId ?? provider?.label ?? ''}</span>
                <span className="hidden w-24 shrink-0 text-right tabular-nums text-[11.5px] text-ink-faint md:inline">{msgs} msg{msgs === 1 ? '' : 's'}{tok > 0 ? '' : ''}</span>
                <span className="hidden w-20 shrink-0 text-right tabular-nums text-[11.5px] text-ink-faint md:inline">{tok > 0 ? `${tok.toLocaleString()} tok` : ''}</span>
                <span className="w-16 shrink-0 text-right tabular-nums text-[11.5px] text-ink-faint">{relTime(now - s.updatedAt)}</span>
              </button>
            );
          })}
        </PanelList>
      )}
      {sessions.length > CAP && (
        <button className="mt-2 text-[12px] text-ink-faint hover:text-ink" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${sessions.length}`}
        </button>
      )}
    </section>
  );
}

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
  useEffect(() => { window.kotrain.getRemoteStatus().then(setRemote).catch(() => setRemote(null)); }, []);
  useEffect(() => { window.kotrain.getMcpStatus().then(setMcp).catch(() => setMcp([])); }, []);
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
        <div className="card p-4 text-[12px] text-ink-faint">No model providers yet, add one in Models.</div>
      )}
    </div>
  );
}

function WorkerCard({ provider, tokens }: { provider: ProviderConfig; tokens?: { input: number; output: number } }) {
  const [state, setState] = useState<'checking' | 'online' | 'offline'>('checking');
  useEffect(() => {
    window.kotrain.testProvider(provider.id).then((r) => setState(r.ok ? 'online' : 'offline')).catch(() => setState('offline'));
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
