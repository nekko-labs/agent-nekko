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

/** A PR card's own vertical margin, which used to set the gap after it. */
const PR_CARD_GAP = 8;

/**
 * One row of the windowed transcript: a message (with the PR cards it is the
 * first to mention), a run of working steps, or the PR cards that were only
 * ever mentioned in tool output, at the end.
 */
export type TranscriptRow =
  | { key: string; kind: 'msg'; message: ChatMessage; prUrls: string[]; gapAfter?: number }
  | { key: string; kind: 'activity'; items: Activity[]; gapAfter?: number }
  | { key: string; kind: 'prs'; urls: string[]; gapAfter?: number };

/**
 * Fold a transcript into rows, the way the console always laid it out: the
 * blocks of `toStreamBlocks`, a PR card right after the message that first
 * names it, and cards for PRs seen only in tool output appended at the end.
 * Keys are unique within the chat and stable as messages are appended.
 */
export function toTranscriptRows(
  messages: ChatMessage[],
  extractUrls: (text: string) => string[],
  collectUrls: (messages: ChatMessage[]) => string[],
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const shown = new Set<string>();
  const keys = new Set<string>();
  const unique = (k: string) => {
    let key = k;
    for (let n = 1; keys.has(key); n++) key = `${k}~${n}`;
    keys.add(key);
    return key;
  };
  for (const b of toStreamBlocks(messages)) {
    if (b.type !== 'msg') {
      rows.push({ key: unique(b.key), kind: 'activity', items: b.items });
      continue;
    }
    const m = b.message;
    // An assistant message with nothing to show renders nothing, so it must not
    // take a row (and a gap) either.
    if (m.role === 'assistant' && !m.content && !m.reasoning && !m.toolCalls?.length) continue;
    const urls = m.role === 'user' ? [] : extractUrls(m.content).filter((u) => !shown.has(u));
    urls.forEach((u) => shown.add(u));
    rows.push({ key: unique(`m_${m.id}`), kind: 'msg', message: m, prUrls: urls, ...(urls.length ? { gapAfter: PR_CARD_GAP } : {}) });
  }
  const orphans = collectUrls(messages).filter((u) => !shown.has(u));
  if (orphans.length) rows.push({ key: unique('orphan_prs'), kind: 'prs', urls: orphans, gapAfter: PR_CARD_GAP });
  return rows;
}

/**
 * A first guess at a row's height (gap included) for a column `width` pixels
 * wide, used until the row has rendered and been measured. It only has to be
 * in the right neighbourhood: the scroll position is corrected as real sizes
 * come in.
 */
export function estimateRowHeight(row: TranscriptRow, width: number): number {
  const gap = row.gapAfter ?? 20;
  if (row.kind === 'activity') return 22 + gap;
  if (row.kind === 'prs') return row.urls.length * 90 + gap;
  const m = row.message;
  const user = m.role === 'user';
  const perLine = Math.max(20, Math.floor(((user ? 0.85 : 1) * Math.max(240, width)) / 7.6));
  let lines = 0;
  for (const line of m.content.split('\n')) lines += Math.max(1, Math.ceil(line.length / perLine));
  const fences = (m.content.match(/```/g)?.length ?? 0) / 2;
  let h = lines * (user ? 22 : 23) + fences * 34 + (user ? 20 : 0);
  if (!user && m.reasoning) h += 26;
  if (!user && m.toolCalls?.length) h += m.toolCalls.length * 26;
  if (m.images?.length) h += 112;
  return h + row.prUrls.length * 90 + gap;
}

/** A stable-ish key per step (tool calls have ids; thoughts and notes don't). */
export function stepKey(it: Activity, i: number): string {
  return it.kind === 'tool' ? `${it.call.id}_${i}` : `${it.kind}_${i}`;
}

export const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

// Formatters are built once: toLocaleTimeString() and toLocaleString() build a
// new one on every call, which is most of the cost of drawing a user bubble.
let timeFormat: Intl.DateTimeFormat | null | undefined;
let dateTimeFormat: Intl.DateTimeFormat | null | undefined;

function formatter(kind: 'time' | 'datetime'): Intl.DateTimeFormat | null {
  try {
    if (kind === 'time') return (timeFormat ??= new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' }));
    // The same fields Date#toLocaleString() fills in when given no options.
    return (dateTimeFormat ??= new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
  } catch {
    return null;
  }
}

/** Short local time for a message timestamp (e.g. "3:42 PM"). */
export function fmtTime(ts: number): string {
  if (!ts) return '';
  try { return formatter('time')?.format(ts) ?? ''; }
  catch { return ''; }
}

/** Full local date and time, as Date#toLocaleString() writes it. */
export function fmtDateTime(ts: number): string {
  try { return formatter('datetime')?.format(ts) ?? new Date(ts).toLocaleString(); }
  catch { return ''; }
}
