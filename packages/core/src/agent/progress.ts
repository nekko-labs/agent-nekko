/**
 * Tool-loop detection: is the agent still getting anywhere?
 *
 * Replies have no tool-step limit: a long, productive coding turn is allowed to
 * run as long as it needs. What ends a reply that is going nowhere is this
 * detector, which watches what the calls *did* and trips on the two patterns a
 * stuck loop actually produces:
 *
 * - the same call (tool + input) coming back with the same result several
 *   times in a short window, which also covers an A→B→A→B cycle;
 * - the same tool failing over and over in a row.
 *
 * Pure and deterministic so the Rust port (crates/nekko-loop/src/progress.rs)
 * can match it exactly. Mirror any change there.
 */

import type { ToolCall, ToolResult } from '@nekko-agent/shared';

/** Recent tool results examined for repeats. */
export const LOOP_WINDOW = 12;
/** Identical call+result occurrences within the window that count as a loop. */
export const LOOP_REPEATS = 3;
/** Consecutive errors from one tool that count as a loop. */
export const LOOP_ERROR_STREAK = 5;

export interface LoopDetector {
  /** Record one finished call. Returns why the run looks stuck, or undefined. */
  push(call: ToolCall, result: ToolResult): string | undefined;
  /** Forget the window, so a nudged model gets a clean slate to prove progress. */
  reset(): void;
}

export function createLoopDetector(): LoopDetector {
  let recent: string[] = [];
  let streakTool = '';
  let streak = 0;

  return {
    push(call, result) {
      const isError = result.isError === true;
      const key = `${call.name}\u0000${JSON.stringify(call.input ?? null)}\u0000${isError ? 1 : 0}\u0000${result.output ?? ''}`;
      recent.push(key);
      if (recent.length > LOOP_WINDOW) recent = recent.slice(recent.length - LOOP_WINDOW);

      if (isError && call.name === streakTool) streak++;
      else if (isError) { streakTool = call.name; streak = 1; }
      else { streakTool = ''; streak = 0; }

      if (streak >= LOOP_ERROR_STREAK) return `${call.name} failing ${streak} times in a row`;
      const same = recent.filter((k) => k === key).length;
      if (same >= LOOP_REPEATS) return `${call.name} with the same input and the same result ${same} times`;
      return undefined;
    },
    reset() {
      recent = [];
      streakTool = '';
      streak = 0;
    },
  };
}

/** The one-off nudge sent (not persisted) when the detector first trips. */
export function loopNudge(reason: string): string {
  return (
    `You appear to be stuck in a loop: ${reason}. Repeating it will not change the result. ` +
    'Try a different approach, or if you are blocked, stop calling tools and explain what is blocking you.'
  );
}

/** The wrap-up prompt when the detector trips a second time. */
export const LOOP_WRAP_UP_PROMPT =
  'You kept repeating tool calls without making progress, so no further tool calls are possible. ' +
  'Answer now with what you already know: what you did, what you found, what is blocking you, and the concrete next steps. ' +
  'Do not ask to run more tools.';

/** The note appended to a reply that was stopped for looping. */
export function loopNote(reason: string): string {
  return `_Stopped early: the agent kept repeating itself (${reason}). Ask me to continue and I'll try a different approach._`;
}
