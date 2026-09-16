import React, { useMemo, useRef, useState } from 'react';
import type {
  AskAnswer,
  AskRequest,
  AutomationTask,
  LiveActivity,
  LiveStep,
  PendingInput,
  ProviderConfig,
  Session,
  TurnExcerpt,
  UsageSummary,
} from '@agent-nekko/shared';
import {
  BLOCKED_META,
  LANE_META,
  SESSION_LANES,
  classifySession,
  recentTurns,
  sessionLane,
  summarizeToolCall,
  taskCadence,
  waitingSince,
  type BlockedReason,
  type SessionLane,
} from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { QuestionCard } from './QuestionCard.js';
import { ChatIcon, ChevronIcon, RobotIcon, ThoughtIcon, ToolStepIcon, TrashIcon } from '../icons.js';

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
/** Turns of conversation on a resting card, and on an opened one. */
const TURNS_COLLAPSED = 2;
const TURNS_EXPANDED = 8;

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
  activity,
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
  /** Live step rails, keyed by session. A mutable map read at paint time. */
  activity: Map<string, LiveActivity>;
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
        <div className="mt-2.5 grid grid-cols-1 gap-4 lg:grid-cols-3">
          {SESSION_LANES.map((lane) => (
            <Lane
              key={lane}
              lane={lane}
              cards={byLane.get(lane) ?? []}
              providers={providers}
              usage={usage}
              childrenOf={childrenOf}
              activity={activity}
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
  lane, cards, providers, usage, childrenOf, activity, now, onOpen, onRefresh,
}: {
  lane: SessionLane;
  cards: BoardCard[];
  providers: ProviderConfig[];
  usage: UsageSummary | null;
  childrenOf: Map<string, Session[]>;
  activity: Map<string, LiveActivity>;
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
        <div className="space-y-2.5">
          {shown.map((c) => (
            <SessionCard
              key={c.session.id}
              card={c}
              provider={providers.find((p) => p.id === c.session.providerId)}
              tokens={usage?.bySession[c.session.id]}
              childrenOf={childrenOf}
              activity={activity.get(c.session.id)}
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
  card, provider, tokens, childrenOf, activity, now, onOpen, onRefresh,
}: {
  card: BoardCard;
  provider?: ProviderConfig;
  tokens?: { input: number; output: number };
  childrenOf: Map<string, Session[]>;
  activity?: LiveActivity;
  now: number;
  onOpen: (id: string) => void;
  onRefresh: () => void;
}) {
  const { session, task, blocked, pending } = card;
  // Open a card to read the exchange rather than to skim it: the same card,
  // more of the same content. Opening the chat is still one click away, but it
  // is no longer the price of reading two more sentences.
  const [expanded, setExpanded] = useState(false);
  const msgs = session.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
  const tok = tokens ? tokens.input + tokens.output : 0;
  const turns = useMemo(
    () => recentTurns(session.messages, expanded ? TURNS_EXPANDED : TURNS_COLLAPSED),
    [session.messages, expanded],
  );
  const swarm = countDescendants(session.id, childrenOf);
  const agentType = classifySession(session, task);
  const live = card.running ? activity : undefined;

  const answer = async (answers: AskAnswer[]) => {
    if (!pending?.question) return;
    await window.nekko.answerQuestion(session.id, pending.question.callId, answers);
    // Don't wait for the resolved event to come back round: the card the user
    // just answered should leave the "needs you" lane as they let go of it.
    onRefresh();
  };

  return (
    <div
      className="rounded-xl border p-3"
      style={{
        borderColor: blocked ? 'color-mix(in srgb, var(--warning) 40%, transparent)' : 'var(--line)',
        background: 'var(--surface)',
      }}
    >
      <div className="flex items-start gap-1.5">
        <span
          className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${card.running ? 'animate-pulse' : ''}`}
          style={{ background: card.running ? 'var(--success)' : blocked ? 'var(--warning)' : 'var(--ink-faint)' }}
        />
        <button
          className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold hover:text-accent"
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

      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-[12px] text-[10.5px] text-ink-faint">
        <span style={{ color: agentType.color }} title={agentType.label}>{agentType.icon}</span>
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
        {live && live.outputTokens > 0 && (
          <span style={{ color: 'var(--success)' }}>· +{live.outputTokens.toLocaleString()} out</span>
        )}
      </div>

      {/* What it is blocked on, first and in full: it is the reason the card is
          in this lane, and answering it here is the whole point of the board. */}
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
      ) : null}

      {/* What it is doing, while it does it. */}
      {live && <LiveRail activity={live} />}

      {/* And what was said, both sides of it. */}
      {turns.length > 0 && <TurnList turns={turns} expanded={expanded} />}

      {(turns.length > 0 || (live?.steps.length ?? 0) > 0) && (
        <button
          className="mt-1 flex items-center gap-1 pl-[12px] text-[10.5px] text-ink-faint hover:text-ink"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <ChevronIcon className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          {expanded ? 'Less' : 'More of this conversation'}
        </button>
      )}

      {(session.queue?.length ?? 0) > 0 && (
        <div className="mt-2 rounded-lg px-2 py-1.5" style={{ background: 'var(--surface-2)' }}>
          <div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-ink-faint">
            Queued ({session.queue!.length})
          </div>
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

      <ReplyBox
        session={session}
        running={card.running}
        question={pending?.question}
        onRefresh={onRefresh}
        onOpen={onOpen}
      />
    </div>
  );
}

/**
 * The run's steps, as it takes them.
 *
 * The board reads sessions off disk, and a session on disk is a finished
 * transcript — so before this, a card could say "working 6m" and nothing about
 * the six minutes. These rows come from the event stream instead: the same
 * sequence the chat's step rail shows, trimmed to the last few and one line
 * each, so a glance answers "what is it doing" without opening anything.
 */
function LiveRail({ activity }: { activity: LiveActivity }) {
  const tail = activity.tail.trim();
  const thinking = activity.thinking.trim();
  return (
    <div
      className="mt-2 rounded-lg border px-2 py-1.5"
      style={{ borderColor: 'color-mix(in srgb, var(--success) 25%, transparent)', background: 'color-mix(in srgb, var(--success) 6%, transparent)' }}
    >
      {activity.steps.length === 0 && !tail && !thinking ? (
        <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: 'var(--success)' }} />
          Starting up<span className="dots" />
        </div>
      ) : (
        <ol className="space-y-0.5">
          {activity.steps.map((s) => <StepRow key={s.id} step={s} />)}
          {thinking && (
            <StepRow
              key="thinking-now"
              step={{ id: 'thinking-now', kind: 'thinking', label: 'Thinking', detail: '', at: activity.updatedAt }}
              live
            />
          )}
        </ol>
      )}
      {tail && (
        <p className="mt-1 line-clamp-3 border-t pt-1 text-[11.5px] leading-snug text-ink-soft" style={{ borderColor: 'var(--line)' }}>
          {tail}
        </p>
      )}
    </div>
  );
}

/** One live step: what it was, what it was pointed at, how it came back. */
function StepRow({ step, live = false }: { step: LiveStep; live?: boolean }) {
  const running = live || step.status === 'running';
  const color = step.status === 'error' ? 'var(--danger)' : running ? 'var(--success)' : 'var(--ink-soft)';
  return (
    <li className="flex list-none items-baseline gap-1.5 font-mono text-[10.5px] leading-tight">
      <span className="shrink-0 self-center" style={{ color }}>
        {step.kind === 'thinking'
          ? <ThoughtIcon className="h-3 w-3 text-ink-faint" />
          : <ToolStepIcon className="h-3 w-3" />}
      </span>
      <span className="shrink-0 font-medium" style={{ color }}>{step.label}</span>
      {step.detail && <span className="min-w-0 flex-1 truncate text-ink-faint" title={step.detail}>· {step.detail}</span>}
      {running && <span className="dots shrink-0" />}
      {step.result && !running && (
        <span className="ml-auto max-w-[45%] shrink-0 truncate text-ink-faint opacity-70" title={step.result}>{step.result}</span>
      )}
    </li>
  );
}

/**
 * The tail of the conversation, both sides of it.
 *
 * One clamped paragraph of the agent's last message used to be the whole of a
 * card's content, which is the half you can least make sense of alone: a reply
 * without the instruction above it reads as a non-sequitur. Showing the
 * exchange costs a line and makes the card legible on its own.
 */
function TurnList({ turns, expanded }: { turns: TurnExcerpt[]; expanded: boolean }) {
  return (
    <div className={`mt-2 space-y-1.5 ${expanded ? 'max-h-72 overflow-y-auto pr-1' : ''}`}>
      {turns.map((t) => (
        <div key={t.id} className="flex gap-1.5">
          <span
            className="w-[30px] shrink-0 pt-[1px] text-[9.5px] font-semibold uppercase tracking-wide"
            style={{ color: t.role === 'user' ? 'var(--ink-faint)' : 'var(--accent)' }}
          >
            {t.role === 'user' ? 'You' : 'Nekko'}
          </span>
          <p
            className={`min-w-0 flex-1 whitespace-pre-wrap text-[11.5px] leading-snug ${expanded ? '' : 'line-clamp-3'} ${t.role === 'user' ? 'text-ink-faint' : 'text-ink-soft'}`}
          >
            {t.text}
            {t.interrupted && <span className="ml-1 text-[10px] italic" style={{ color: 'var(--warning)' }}>(cut off)</span>}
          </p>
        </div>
      ))}
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
 *
 * While the agent is waiting on an answer, the box answers it. Sending a fresh
 * turn at a run parked inside `ask_user` would queue behind the very question
 * it answers, so what you type goes back as the reply to the first question —
 * the same thing the card's "Something else" box does, without hunting for it.
 */
function ReplyBox({
  session, running, question, onRefresh, onOpen,
}: {
  session: Session;
  running: boolean;
  /** Set when the agent is parked on a question; typing here answers it. */
  question?: AskRequest;
  onRefresh: () => void;
  onOpen: (id: string) => void;
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

    if (question) {
      setBusy(true);
      setText('');
      try {
        await window.nekko.answerQuestion(session.id, question.callId, [
          { questionId: question.questions[0].id, labels: [], note: body },
        ]);
        onRefresh();
      } catch (e) {
        setText(body);
        pushToast('error', (e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }

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
        onRefresh();
      } else {
        // `sendChat` settles when the whole turn does, which can be minutes.
        // Waiting on it would freeze the card for the length of the run, so the
        // send is let go of and the board picks the turn up from its events —
        // the same way it follows a run started anywhere else.
        void window.nekko
          .sendChat({ sessionId: session.id, providerId, modelId, text: body })
          .catch((e: Error) => pushToast('error', e.message))
          .finally(onRefresh);
        // A beat for the host to write the user turn, so it shows on the card
        // before the first token comes back.
        setTimeout(onRefresh, 200);
      }
    } catch (e) {
      setText(body);
      pushToast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const action = question ? 'Answer' : running ? 'Queue' : 'Send';
  return (
    <div className="mt-2 flex items-center gap-1.5">
      <input
        ref={input}
        className="input min-w-0 flex-1 py-1 text-[11.5px]"
        placeholder={question ? 'Answer in your own words…' : running ? 'Queue the next instruction' : 'Reply…'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
        }}
      />
      <button
        className="btn btn-ghost shrink-0 px-1.5 py-1 text-[11px]"
        title={question ? 'Send this as the answer' : running ? 'Queue this' : 'Send'}
        disabled={!text.trim() || busy}
        onClick={() => void submit()}
      >
        {action}
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

