import type { ChatMessage, ToolCall } from '@agent-nekko/shared';

/**
 * Pure transcript model for the agent console: how a raw message list folds
 * into the blocks the console renders (tool calls, reasoning, narration, the
 * final answer), plus the small formatters those blocks share.
 */

/** One step of an assistant turn: a tool call, a reasoning block, or a bit of
 *  narration text between tools. Grouped into a single collapsible section. */
export type Activity =
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'reasoning'; text: string; duration: number | null }
  | { kind: 'note'; text: string };

/** A render block of the transcript: a message bubble (user or the final
 *  assistant answer) or a grouped run of the model's working steps. */
export type StreamBlock =
  | { type: 'msg'; message: ChatMessage }
  | { type: 'activity'; key: string; items: Activity[] };

/**
 * Fold a transcript into render blocks, collapsing each run of the model's
 * working steps (reasoning, tool calls, and inter-tool narration) into one
 * activity group so a many-step turn reads as a single expandable line instead
 * of a wall of "Used <tool>" rows. Only the final answer stays a bubble.
 */
export function toStreamBlocks(messages: ChatMessage[]): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  let run: Activity[] = [];
  let runKey = '';
  const flush = () => {
    if (run.length) { blocks.push({ type: 'activity', key: `act_${runKey}`, items: run }); run = []; }
  };
  /**
   * Narration the model wrote mid-run is speech, not a step.
   *
   * It used to fold into the collapsed activity group as a "Said" row, which
   * meant the model could explain what it was about to do and have that
   * explanation hidden behind a disclosure triangle: the one part of a run
   * written *to the reader* was the part the reader could not see. So it
   * leaves the group as its own bubble, and because a bubble cannot sit inside
   * the group, it also closes the run: the steps before it and the steps after
   * it become separate groups, which is the grouping the sequence already had.
   */
  const say = (m: ChatMessage, i: number) => {
    flush();
    blocks.push({ type: 'msg', message: { ...m, id: `${m.id}_said_${i}`, toolCalls: undefined } });
    runKey = `${m.id}_${i}_after`;
  };
  // The turn's answer is the last assistant message's own text, even when that
  // message also made tool calls, a run cut short by the step budget, an abort,
  // or a model that concludes in the same message as its final tool call.
  // Without this its wrap-up would fold into the collapsed activity group and
  // vanish; mid-run narration still folds in as before.
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });

  messages.forEach((m, i) => {
    if (m.role === 'tool') return;
    if (m.role === 'user') { flush(); blocks.push({ type: 'msg', message: m }); return; }
    // Assistant messages that still call tools are working steps; the one that
    // stops calling tools is the answer.
    if (m.toolCalls?.length) {
      const isFinalAnswer = i === lastAssistant && m.content.trim().length > 0;
      if (!run.length) runKey = `${m.id}_${i}`;
      if (m.reasoning) run.push({ kind: 'reasoning', text: m.reasoning, duration: m.reasoningSeconds ?? null });
      // Narration is written out in full as part of the conversation, and it
      // splits the run in two: what led up to it, and what it went on to do.
      if (m.content.trim() && !isFinalAnswer) say(m, i);
      m.toolCalls.forEach((c) => run.push({ kind: 'tool', call: c }));
      if (isFinalAnswer) { flush(); blocks.push({ type: 'msg', message: m }); }
    } else {
      flush();
      blocks.push({ type: 'msg', message: m });
    }
  });
  flush();
  return blocks;
}

/** A stable-ish key per step (tool calls have ids; thoughts and notes don't). */
export function stepKey(it: Activity, i: number): string {
  return it.kind === 'tool' ? `${it.call.id}_${i}` : `${it.kind}_${i}`;
}

export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

/** Short local time for a message timestamp (e.g. "3:42 PM"). */
export function fmtTime(ts: number): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
