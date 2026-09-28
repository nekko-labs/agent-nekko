/**
 * Every running turn, folded and kept alive for as long as the host is running
 * it, not for as long as somebody is looking at it.
 *
 * The chat pane used to be the only thing subscribed to the agent event stream,
 * which made watching a run a precondition for recording it. Workspaces render
 * only the active one, so switching tabs unmounted the pane, dropped its
 * listener, and threw away the partial reply, the tool list and the elapsed
 * clock. Coming back mounted a fresh pane with empty state, which is why the
 * run looked paused until the next event repainted it a second or two later.
 * Nothing was ever actually paused: the host streams to a channel nobody was
 * holding, so the tokens emitted while you were away were simply lost.
 *
 * So the subscription moves here: one listener for the whole app, started at
 * launch, that folds every session's events whether or not a pane exists. A
 * pane becomes a *view* of this, and mounting one replays what it missed.
 *
 * Deliberately outside React and outside the zustand store. Tokens arrive dozens
 * of times a second and every one of them would be a store write, re-rendering
 * every subscriber in the app; instead the state lives in a plain Map and
 * components subscribe to the sessions they care about on an animation-frame
 * cadence. `useLiveRun` below is the whole public surface for a component.
 */

import { useSyncExternalStore } from 'react';
import type { AgentEvent, ToolCall } from '@agent-nekko/shared';
import { describeLiveActivity, emptyLiveActivity, reduceLiveActivity, type LiveActivity } from '@agent-nekko/shared';

/** One session's in-flight turn, as much of it as a pane needs to redraw. */
export interface LiveRun {
  sessionId: string;
  /** The assistant text streamed so far this turn. */
  text: string;
  /** Reasoning streamed so far this turn. */
  reasoning: string;
  /** Tool calls made this turn, in order. */
  tools: ToolCall[];
  /** When the turn started, for the elapsed clock. */
  startedAt: number;
  /** Output tokens and decode time, summed across the turn's steps. */
  outputTokens: number;
  decodeMs: number;
  inputTokens: number;
  /** Milliseconds of reasoning, once a thought has been closed out by text. */
  reasoningMs: number;
  /** Set while reasoning is streaming, so the pane can show the thinking dot. */
  reasoningStartedAt: number;
  /** The folded step rail, shared with the Command Center's cards. */
  activity: LiveActivity;
}

const runs = new Map<string, LiveRun>();
/** Per-session subscriber sets, so a pane only wakes for its own chat. */
const listeners = new Map<string, Set<() => void>>();
/** Subscribers that want to know about *any* change (the sub-agent rail). */
const globalListeners = new Set<() => void>();

/**
 * Snapshots handed to React. `useSyncExternalStore` compares by identity and
 * re-renders whenever the reference changes, so a run is replaced wholesale on
 * each repaint and the map below caches the current object per session.
 */
let version = 0;

function emptyRun(sessionId: string, now: number): LiveRun {
  return {
    sessionId,
    text: '',
    reasoning: '',
    tools: [],
    startedAt: now,
    outputTokens: 0,
    decodeMs: 0,
    inputTokens: 0,
    reasoningMs: 0,
    reasoningStartedAt: 0,
    activity: emptyLiveActivity(now),
  };
}

/**
 * Sessions whose next repaint is still pending.
 *
 * Coalescing to one frame is what keeps a fast local model from re-rendering
 * the transcript per token: the run is mutated immediately (so a pane mounting
 * mid-frame reads current state) and subscribers are told at most 60 times a
 * second.
 */
const dirty = new Set<string>();
let frame: number | null = null;

function markDirty(sessionId: string): void {
  dirty.add(sessionId);
  if (frame != null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    const wake = [...dirty];
    dirty.clear();
    version++;
    for (const id of wake) for (const fn of listeners.get(id) ?? []) fn();
    for (const fn of globalListeners) fn();
  });
}

/**
 * Fold one event into its session's run.
 *
 * Exported for the tests: the interesting behaviour is that a turn accumulates
 * across events and is dropped on `done`/`error`, and that is provable without
 * a DOM or an IPC bridge.
 */
export function applyEvent(event: AgentEvent, now = Date.now()): void {
  const id = event.sessionId;

  // The rail folds first, so a card repainted this frame is never a step behind.
  const folded = reduceLiveActivity(runs.get(id)?.activity, event, now);

  if (event.type === 'done' || event.type === 'error') {
    runs.delete(id);
    markDirty(id);
    return;
  }

  const prev = runs.get(id) ?? emptyRun(id, now);
  const next: LiveRun = { ...prev, activity: folded ?? prev.activity };

  switch (event.type) {
    case 'text':
      // Text closes out whatever was being thought, which is what makes the
      // "Thought for Ns" duration a measurement rather than a guess.
      if (next.reasoningStartedAt) {
        next.reasoningMs += now - next.reasoningStartedAt;
        next.reasoningStartedAt = 0;
      }
      next.text = prev.text + event.delta;
      break;
    case 'reasoning':
      if (!next.reasoningStartedAt) next.reasoningStartedAt = now;
      next.reasoning = prev.reasoning + event.delta;
      break;
    case 'tool_call':
      if (next.reasoningStartedAt) {
        next.reasoningMs += now - next.reasoningStartedAt;
        next.reasoningStartedAt = 0;
      }
      next.tools = [...prev.tools, event.call];
      break;
    case 'usage':
      next.outputTokens = prev.outputTokens + event.outputTokens;
      next.inputTokens = prev.inputTokens + event.inputTokens;
      next.decodeMs = prev.decodeMs + (event.outputMs ?? 0);
      break;
    default:
      // Approvals and questions are pending-input state, owned by the host and
      // read back from it; recording them here would duplicate that.
      break;
  }

  runs.set(id, next);
  markDirty(id);
}

/** Start folding events for the whole app. Called once, at launch. */
export function startLiveRuns(): () => void {
  return window.nekko.onAgentEvent((e: AgentEvent) => applyEvent(e));
}

/** The run in flight for a session, or undefined when it is idle. */
export function getLiveRun(sessionId: string): LiveRun | undefined {
  return runs.get(sessionId);
}

/** Every session with a turn in flight. */
export function runningSessionIds(): string[] {
  return [...runs.keys()];
}

/**
 * Drop a session's run.
 *
 * The pane calls this when it has folded the finished turn into the persisted
 * transcript, so the live copy and the stored copy are never both on screen.
 */
export function clearLiveRun(sessionId: string): void {
  if (!runs.delete(sessionId)) return;
  markDirty(sessionId);
}

function subscribeTo(sessionId: string, fn: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) listeners.set(sessionId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(sessionId);
  };
}

/**
 * Subscribe a component to one session's live run.
 *
 * Returns `undefined` while that chat is idle, which is the signal to render
 * the stored transcript instead.
 */
export function useLiveRun(sessionId: string): LiveRun | undefined {
  return useSyncExternalStore(
    (fn) => subscribeTo(sessionId, fn),
    () => runs.get(sessionId),
  );
}

/**
 * Subscribe to the set of running sessions, as a version counter.
 *
 * The sub-agent rail needs to repaint when any of several children moves, and
 * the children change as they are spawned; watching the counter is simpler than
 * juggling a subscription per child id.
 */
export function useLiveRunsVersion(): number {
  return useSyncExternalStore((fn) => {
    globalListeners.add(fn);
    return () => globalListeners.delete(fn);
  }, () => version);
}

/** What a session is doing right now, in a few words. Empty when idle. */
export function describeRun(sessionId: string): string {
  return describeLiveActivity(runs.get(sessionId)?.activity);
}

/** Reset everything. Tests only. */
export function __resetLiveRuns(): void {
  runs.clear();
  listeners.clear();
  globalListeners.clear();
  dirty.clear();
  if (frame != null) cancelAnimationFrame(frame);
  frame = null;
}
