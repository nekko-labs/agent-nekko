/**
 * What a chat is doing *right now*, folded from its event stream.
 *
 * The board reads sessions off disk, and a session on disk is a finished
 * transcript: while a turn is in flight its steps exist only as events, so a
 * card that renders the stored session can say "working 4m" and nothing about
 * what the four minutes went on. That is the one thing you open the Command
 * Center to find out, so the events are folded here instead — the same shape
 * the chat's own step rail shows, kept small enough to sit on a card.
 *
 * Pure and synchronous: the renderer keeps one of these per running session and
 * hands each event to `reduceLiveActivity`. Nothing here touches React, so the
 * folding is testable without a DOM.
 */

import type { AgentEvent } from './chat.js';
import { summarizeThought, summarizeToolCall, truncateWords } from './agent-steps.js';

/** A thought, a tool call, or a line the model said between tools. */
export type LiveStepKind = 'thinking' | 'tool' | 'note';

export interface LiveStep {
  /** Stable within one run, so React keys don't churn as steps stream in. */
  id: string;
  kind: LiveStepKind;
  /** The tool's name, or "Thinking" / "Said". */
  label: string;
  /** One line: what the tool was pointed at, or where the thought landed. */
  detail: string;
  at: number;
  /** Tool steps only: still running, or how it came back. */
  status?: 'running' | 'ok' | 'error';
  /** Tool steps only: the head of what it returned. */
  result?: string;
}

export interface LiveActivity {
  steps: LiveStep[];
  /** The narration streaming right now, tail-trimmed. */
  tail: string;
  /** Reasoning streamed since the last step, not yet folded into one. */
  thinking: string;
  startedAt: number;
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Steps kept per run. Older ones fall off the top; a card is not a transcript. */
export const LIVE_STEP_CAP = 6;
/** Characters of streaming narration kept. Enough to read the current thought. */
export const LIVE_TAIL_CHARS = 360;

export function emptyLiveActivity(now: number): LiveActivity {
  return { steps: [], tail: '', thinking: '', startedAt: now, updatedAt: now, inputTokens: 0, outputTokens: 0 };
}

/**
 * Fold one event into a session's live activity.
 *
 * Returns `undefined` when the run is over, which is the signal to drop the
 * entry: once the turn lands, the stored transcript says it better than a
 * half-remembered event stream, and a stale rail under a finished card is worse
 * than no rail at all.
 */
export function reduceLiveActivity(
  prev: LiveActivity | undefined,
  event: AgentEvent,
  now: number,
): LiveActivity | undefined {
  if (event.type === 'done' || event.type === 'error') return undefined;

  const a: LiveActivity = prev ? { ...prev, steps: [...prev.steps] } : emptyLiveActivity(now);
  a.updatedAt = now;

  switch (event.type) {
    case 'reasoning':
      a.thinking += event.delta;
      break;

    case 'text':
      // A thought that ends in narration is finished being thought.
      flushThinking(a, now);
      a.tail = tailOf(a.tail + event.delta);
      break;

    case 'tool_call': {
      flushThinking(a, now);
      flushNarration(a, now);
      push(a, {
        id: event.call.id,
        kind: 'tool',
        label: event.call.name,
        detail: summarizeToolCall(event.call, 70),
        at: now,
        status: 'running',
      });
      break;
    }

    case 'tool_approval_required':
      // The card shows the approval itself; recording it twice would put the
      // same command in the rail and in the buttons under it.
      break;

    case 'tool_result': {
      const step = lastRunningTool(a.steps, event.result.toolCallId);
      if (step) {
        const i = a.steps.indexOf(step);
        a.steps[i] = {
          ...step,
          status: event.result.isError ? 'error' : 'ok',
          result: firstLine(event.result.output),
        };
      }
      break;
    }

    case 'usage':
      a.inputTokens += event.inputTokens;
      a.outputTokens += event.outputTokens;
      break;

    default:
      break;
  }

  return a;
}

/** Turn buffered reasoning into a step. Silent when there is nothing worth one. */
function flushThinking(a: LiveActivity, now: number): void {
  const text = a.thinking.trim();
  a.thinking = '';
  if (text.length < 12) return;
  push(a, {
    id: `think_${now}_${a.steps.length}`,
    kind: 'thinking',
    label: 'Thinking',
    detail: summarizeThought(text, 70) || 'Worked it through',
    at: now,
  });
}

/** Turn narration the model has finished saying into a step. */
function flushNarration(a: LiveActivity, now: number): void {
  const text = a.tail.trim();
  a.tail = '';
  if (text.length < 12) return;
  push(a, {
    id: `note_${now}_${a.steps.length}`,
    kind: 'note',
    label: 'Said',
    detail: truncateWords(text.replace(/\s+/g, ' '), 70),
    at: now,
  });
}

function push(a: LiveActivity, step: LiveStep): void {
  a.steps.push(step);
  if (a.steps.length > LIVE_STEP_CAP) a.steps.splice(0, a.steps.length - LIVE_STEP_CAP);
}

/**
 * The step a result belongs to. Matched by call id when the ids line up, and
 * otherwise by "the tool still running", because some providers hand back a
 * result id that never appeared on the call.
 */
function lastRunningTool(steps: LiveStep[], toolCallId: string): LiveStep | undefined {
  const byId = steps.find((s) => s.kind === 'tool' && s.id === toolCallId);
  if (byId) return byId;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === 'tool' && steps[i].status === 'running') return steps[i];
  }
  return undefined;
}

function tailOf(text: string): string {
  return text.length <= LIVE_TAIL_CHARS ? text : text.slice(text.length - LIVE_TAIL_CHARS);
}

function firstLine(output: string): string {
  const line = (output ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return truncateWords(line, 70);
}

/**
 * The one line a card shows when there is no room for the rail: what the agent
 * is doing at this instant, in the present tense.
 */
export function describeLiveActivity(a: LiveActivity | undefined): string {
  if (!a) return '';
  if (a.thinking.trim()) return summarizeThought(a.thinking, 80) || 'Thinking';
  const last = a.steps[a.steps.length - 1];
  if (last?.kind === 'tool' && last.status === 'running') {
    return last.detail ? `${last.label} · ${last.detail}` : last.label;
  }
  if (a.tail.trim()) return truncateWords(a.tail.replace(/\s+/g, ' ').trim(), 80);
  if (last) return last.detail ? `${last.label} · ${last.detail}` : last.label;
  return 'Starting';
}
