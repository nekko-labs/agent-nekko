import React, { useMemo, useRef, useState } from 'react';
import type {
  AskAnswer,
  AutomationTask,
  PendingInput,
  ProviderConfig,
  Session,
  UsageSummary,
} from '@agent-nekko/shared';
import {
  BLOCKED_META,
  LANE_META,
  SESSION_LANES,
  classifySession,
  sessionLane,
  summarizeToolCall,
  taskCadence,
  waitingSince,
  type BlockedReason,
  type SessionLane,
} from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { QuestionCard } from './QuestionCard.js';
import { ChatIcon, RobotIcon, TrashIcon } from '../icons.js';

/**
 * The Command Center board: every chat as a card, in the lane its state puts it
 * in, and enough of each chat on the card to deal with it here.
 *
 * The thing this replaces was two lists — "Now" and "Sessions" — that between
 * them could not answer "what needs me": a run that had stopped to ask a
 * question sat in the same flat list as one that finished an hour ago, and
 * every card was a link to somewhere else. So the lanes are *blocked*,
 * *running*, *idle*, and each card carries the controls for its own state:
 * answer the question, approve the command, stop the run, or write the next
 * instruction. Opening the chat is for reading the transcript, not for keeping
 * the work moving.
 */

/** Cards shown per lane before the lane offers to show the rest. */
const LANE_CAP = 6;

export interface BoardCard {
  session: Session;
  task?: AutomationTask;
  lane: SessionLane;
  blocked?: BlockedReason;
  pending?: PendingInput;
  running: boolean;
  startedAt?: number;
}

export function SessionBoard({
  sessions,
  tasks,
  providers,
  usage,
  running,
  pending,
  childrenOf,
  runStarts,
  now,
  onOpen,
  onRefresh,
  onNewChat,
}: {
  sessions: Session[];
  tasks: AutomationTask[];
  providers: ProviderConfig[];
  usage: UsageSummary | null;
  running: Set<string>;
  pending: Record<string, PendingInput>;
  childrenOf: Map<string, Session[]>;
  runStarts: Map<string, number>;
  now: number;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  onNewChat: () => void;
}) {
  const taskBySession = useMemo(() => {
    const m = new Map<string, AutomationTask>();
    for (const t of tasks) if (t.lastSessionId) m.set(t.lastSessionId, t);
    return m;
  }, [tasks]);

  // A chat counts as working when it, or anything it delegated to, is running:
  // a parent parked on `spawn_agent` is not idle, it is waiting on its swarm.
  const isRunning = useMemo(() => {
    const check = (s: Session): boolean =>
      running.has(s.id) || (childrenOf.get(s.id) ?? []).some(check);
    return check;
  }, [running, childrenOf]);

  const cards = useMemo<BoardCard[]>(
    () =>
      sessions.map((session) => {
        const p = pending[session.id];
        const live = isRunning(session);
        const { lane, blocked } = sessionLane({ running: live, pending: p, messages: session.messages });
        return {
          session,
          task: taskBySession.get(session.id),
          lane,
          blocked,
          pending: p,
          running: live,
          startedAt: runStarts.get(session.id),
        };
      }),
    [sessions, pending, isRunning, taskBySession, runStarts],
  );

  const byLane = useMemo(() => {
    const m = new Map<SessionLane, BoardCard[]>(SESSION_LANES.map((l) => [l, []]));
    for (const c of cards) m.get(c.lane)!.push(c);
    // Blocked cards lead with whatever has been waiting longest; the rest are
    // most-recent-first, as every other list in the app is.
    m.get('needs-you')!.sort(
      (a, b) => (waitingSince(a.pending) || a.session.updatedAt) - (waitingSince(b.pending) || b.session.updatedAt),
    );
    m.get('working')!.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    m.get('idle')!.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
    return m;
  }, [cards]);

  const total = cards.length;

  return (
    <section className="mt-7">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold">Sessions</h2>
        <span className="text-[12px] text-ink-faint">
          {total === 0 ? 'your chats, by what they need' : `${total} chat${total === 1 ? '' : 's'}, by what they need`}
        </span>
      </div>

      {total === 0 ? (
        <div className="mt-2.5 rounded-xl border border-dashed p-4 text-[12.5px] text-ink-faint" style={{ borderColor: 'var(--line)' }}>
          No chats yet.{' '}
          <button className="text-accent hover:underline" onClick={onNewChat}>Start one</button> and it shows up here.
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-1 gap-3 lg:grid-cols-3">
          {SESSION_LANES.map((lane) => (
            <Lane
              key={lane}
              lane={lane}
              cards={byLane.get(lane) ?? []}
              providers={providers}
              usage={usage}
              childrenOf={childrenOf}
              now={now}
              onOpen={onOpen}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Lane({
  lane, cards, providers, usage, childrenOf, now, onOpen, onRefresh,
}: {
  lane: SessionLane;
  cards: BoardCard[];
  providers: ProviderConfig[];
  usage: UsageSummary | null;
  childrenOf: Map<string, Session[]>;
  now: number;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const meta = LANE_META[lane];
  const shown = showAll ? cards : cards.slice(0, LANE_CAP);

  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.tone }} />
        <span className="text-[12px] font-semibold">{meta.title}</span>
        <span className="rounded-full px-1.5 text-[10.5px] tabular-nums text-ink-faint" style={{ background: 'var(--surface-2)' }}>
          {cards.length}
        </span>
      </div>
      {cards.length === 0 ? (
        <p className="rounded-xl border border-dashed px-3 py-4 text-center text-[11.5px] text-ink-faint" style={{ borderColor: 'var(--line)' }}>
          {meta.blurb}
        </p>
      ) : (
        <div className="space-y-2">
          {shown.map((c) => (
            <SessionCard
              key={c.session.id}
              card={c}
              provider={providers.find((p) => p.id === c.session.providerId)}
              tokens={usage?.bySession[c.session.id]}
              childrenOf={childrenOf}
              now={now}
              onOpen={onOpen}
              onRefresh={onRefresh}
            />
          ))}
          {cards.length > LANE_CAP && (
            <button className="w-full py-1 text-[11.5px] text-ink-faint hover:text-ink" onClick={() => setShowAll((v) => !v)}>
              {showAll ? 'Show fewer' : `Show all ${cards.length}`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SessionCard({
  card, provider, tokens, childrenOf, now, onOpen, onRefresh,
}: {
  card: BoardCard;
  provider?: ProviderConfig;
  tokens?: { input: number; output: number };
  childrenOf: Map<string, Session[]>;
  now: number;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const { session, task, blocked, pending } = card;
  const msgs = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
  const tok = tokens ? tokens.input + tokens.output : 0;
  const lastAssistant = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  const swarm = countDescendants(session.id, childrenOf);
  const agentType = classifySession(session, task);

  const answer = async (answers: AskAnswer[]) => {
    if (!pending?.question) return;
    await window.nekko.answerQuestion(session.id, pending.question.callId, answers);
  };

  return (
    <div
      className="rounded-xl border p-2.5"
      style={{
        borderColor: blocked ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'var(--line)',
        background: 'var(--surface)',
      }}
    >
      <div className="flex items-start gap-1.5">
        <span
          className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${card.running ? 'animate-pulse' : ''}`}
          style={{ background: card.running ? 'var(--success)' : blocked ? 'var(--warning)' : 'var(--ink-faint)' }}
        />
        <button
          className="min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold hover:text-accent"
          onClick={() => onOpen(session.id)}
          title={`Open ${session.title}`}
        >
          {task ? task.title : session.title}
        </button>
        {card.running ? (
          <button
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-ink"
            onClick={() => window.nekko.abortChat(session.id)}
            title="Stop this run"
          >
            Stop
          </button>
        ) : (
          <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">{relTime(now - session.updatedAt)}</span>
        )}
      </div>

      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-[12px] text-[10.5px] text-ink-faint">
        <span style={{ color: agentType.color }}>{agentType.icon}</span>
        <span className="truncate">{session.modelId ?? provider?.label ?? 'no model'}</span>
        <span>· {msgs} msg{msgs === 1 ? '' : 's'}</span>
        {tok > 0 && <span>· {tok.toLocaleString()} tok</span>}
        {task && <span>· {taskCadence(task)}</span>}
        {swarm > 0 && (
          <span className="flex items-center gap-0.5" title={`${swarm} sub-agent${swarm === 1 ? '' : 's'}`}>
            · <RobotIcon className="h-3 w-3" /> {swarm}
          </span>
        )}
        {card.running && card.startedAt && (
          <span style={{ color: 'var(--success)' }}>· working {elapsed(now - card.startedAt)}</span>
        )}
      </div>

      {/* What it is blocked on, in the card, answerable in the card. */}
      {pending?.question ? (
        <div className="mt-2">
          <QuestionCard request={pending.question} onAnswer={answer} onSkip={() => answer([])} compact />
        </div>
      ) : pending?.approval ? (
        <ApprovalRow
          sessionId={session.id}
          callId={pending.approval.call.id}
          summary={summarizeToolCall(pending.approval.call)}
          reason={pending.approval.reason}
          severity={pending.approval.severity}
        />
      ) : blocked === 'interrupted' ? (
        <StalledRow session={session} onOpen={onOpen} />
      ) : (
        lastAssistant && (
          <p className="mt-1.5 line-clamp-2 pl-[12px] text-[11.5px] leading-snug text-ink-soft">
            {lastAssistant.content.slice(0, 220)}
          </p>
        )
      )}

      {(session.queue?.length ?? 0) > 0 && (
        <div className="mt-1.5 pl-[12px]">
          {session.queue!.map((q, i) => (
            <div key={i} className="group/q flex items-center gap-1.5 text-[11px] text-ink-faint">
              <span className="shrink-0 tabular-nums text-[9.5px]">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate" title={q}>{q}</span>
              <button
                className="shrink-0 rounded-sm p-0.5 opacity-0 hover:text-(--danger) group-hover/q:opacity-100"
                title="Remove from the queue"
                onClick={async () => { await window.nekko.dequeuePrompt(session.id, i); onRefresh(); }}
              >
                <TrashIcon className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <ReplyBox session={session} running={card.running} onRefresh={onRefresh} onOpen={onOpen} />
    </div>
  );
}

/** A command waiting on approve/deny, decided without leaving the board. */
function ApprovalRow({
  sessionId, callId, summary, reason, severity,
}: {
  sessionId: string; callId: string; summary: string; reason: string;
  severity: 'low' | 'medium' | 'high';
}) {
  const tone = severity === 'high' ? 'var(--danger)' : 'var(--warning)';
  return (
    <div
      className="mt-2 rounded-lg border p-2"
      style={{ borderColor: `color-mix(in srgb, ${tone} 35%, transparent)`, background: `color-mix(in srgb, ${tone} 8%, transparent)` }}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" aria-hidden>{BLOCKED_META.approval.icon}</span>
        <span className="text-[11px] font-semibold" style={{ color: tone }}>{reason}</span>
      </div>
      <code className="mt-1 block truncate font-mono text-[10.5px] text-ink-soft" title={summary}>{summary}</code>
      <div className="mt-1.5 flex gap-1.5">
        <button className="btn btn-primary px-2 py-0.5 text-[11px]" onClick={() => window.nekko.approveTool(sessionId, callId, true)}>
          Approve
        </button>
        <button className="btn btn-ghost px-2 py-0.5 text-[11px]" onClick={() => window.nekko.approveTool(sessionId, callId, false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/** A reply that stopped part-way: resumed, or re-run, from here. */
function StalledRow({ session, onOpen }: { session: Session; onOpen: (id: string) => void }) {
  const pushToast = useStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    const providerId = session.providerId;
    const modelId = session.modelId;
    if (!providerId || !modelId) {
      pushToast('info', 'This chat has no model set yet. Open it and pick one.');
      onOpen(session.id);
      return;
    }
    setBusy(true);
    await window.nekko.sendChat({ sessionId: session.id, providerId, modelId, text: '', resume: true }).catch((e: Error) => {
      pushToast('error', e.message);
    });
    setBusy(false);
  };
  return (
    <div className="mt-2 rounded-lg border p-2" style={{ borderColor: 'color-mix(in srgb, var(--warning) 30%, transparent)' }}>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px]" aria-hidden>{BLOCKED_META.interrupted.icon}</span>
        <span className="text-[11px] font-semibold" style={{ color: 'var(--warning)' }}>
          {BLOCKED_META.interrupted.label}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-ink-faint">Its last reply was cut off. Carrying on keeps the steps it already took.</p>
      <button className="btn btn-outline mt-1.5 px-2 py-0.5 text-[11px]" disabled={busy} onClick={resume}>
        {busy ? 'Resuming…' : 'Carry on'}
      </button>
    </div>
  );
}

/**
 * The next instruction, typed on the card.
 *
 * This is what makes the board a place to work rather than a place to look: the
 * common move on a chat you have just read is one more sentence, and that used
 * to cost opening it, waiting for the pane, and finding the composer. While the
 * agent is mid-run the same box queues instead of sending, which is what the
 * chat's own composer does, so the behaviour does not change with the screen.
 */
function ReplyBox({
  session, running, onRefresh, onOpen,
}: {
  session: Session; running: boolean; onRefresh: () => void; onOpen: (id: string) => void;
}) {
  const settings = useStore((s) => s.settings);
  const pushToast = useStore((s) => s.pushToast);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const providerId = session.providerId ?? settings?.defaultProviderId;
  const modelId = session.modelId ?? settings?.defaultModelId;

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    // A chat that has never picked a model cannot be run from here: the picker
    // lives in the chat, so say so and take them there rather than failing.
    if (!providerId || !modelId) {
      pushToast('info', 'Pick a model for this chat first.');
      onOpen(session.id);
      return;
    }
    setBusy(true);
    setText('');
    try {
      if (running) {
        await window.nekko.queuePrompt(session.id, body);
        pushToast('info', 'Queued. It runs when the current reply finishes.');
      } else {
        await window.nekko.sendChat({ sessionId: session.id, providerId, modelId, text: body });
      }
      onRefresh();
    } catch (e) {
      setText(body);
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <input
        ref={input}
        className="input min-w-0 flex-1 py-1 text-[11.5px]"
        placeholder={running ? 'Queue the next instruction' : 'Reply…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
        }}
      />
      <button
        className="btn btn-ghost shrink-0 px-1.5 py-1 text-[11px]"
        title={running ? 'Queue this' : 'Send'}
        disabled={!text.trim() || busy}
        onClick={() => void submit()}
      >
        {running ? 'Queue' : 'Send'}
      </button>
      <button
        className="btn btn-ghost shrink-0 px-1.5 py-1 text-[11px] text-ink-faint"
        title="Open this chat"
        onClick={() => onOpen(session.id)}
      >
        <ChatIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Count every descendant sub-agent under a session. */
function countDescendants(id: string, childrenOf: Map<string, Session[]>): number {
  return (childrenOf.get(id) ?? []).reduce((n, k) => n + 1 + countDescendants(k.id, childrenOf), 0);
}

function relTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

