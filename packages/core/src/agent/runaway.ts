/**
 * Runaway-output detection.
 *
 * Local models occasionally degenerate mid-generation and emit the same phrase
 * forever ("Let me start building this feature now." x2534 was one observed
 * case, 108k characters of reasoning in a single reply). Nothing upstream stops
 * that on its own: the server happily streams until the context window fills,
 * every token crosses IPC into the renderer, and the reply neither finishes nor
 * fails. A per-stream output cap (see MAX_OUTPUT_TOKENS_DEFAULT) bounds the
 * damage, but it still means minutes of dead waiting.
 *
 * This guard watches a stream as it arrives and reports the moment the output
 * has collapsed into a cycle, so the caller can cut the stream off and tell the
 * user what happened instead of letting the reply hang.
 */

/** How the guard decides an output has collapsed into a loop. */
export interface RunawayOptions {
  /**
   * Trailing characters examined. A cycle longer than about a quarter of this
   * is not detected here; the output cap is the backstop for those.
   */
  window?: number;
  /** Don't judge anything shorter than this (short repeats are often legitimate). */
  minChars?: number;
  /** Re-test every this many characters, so the check is amortized, not per-token. */
  checkEvery?: number;
  /** Occurrences of the trailing probe within the window that count as a loop. */
  repeats?: number;
  /** Length of the trailing probe matched against the window. */
  probe?: number;
  /** Distinct non-blank lines in the window at or below which it reads as a loop. */
  minDistinctLines?: number;
  /** Non-blank lines needed in the window before the line test applies. */
  minLines?: number;
}

const DEFAULTS: Required<RunawayOptions> = {
  window: 8_000,
  minChars: 1_500,
  checkEvery: 1_000,
  repeats: 6,
  probe: 160,
  minDistinctLines: 3,
  minLines: 12,
};

export interface RunawayGuard {
  /**
   * Feed the next streamed delta. Returns true the first time the accumulated
   * output looks like a loop; the caller should stop the stream. Stays true on
   * later calls so a caller that keeps pushing still sees the verdict.
   */
  push(delta: string): boolean;
  /** True once the guard has tripped. */
  readonly tripped: boolean;
}

/**
 * Track a stream's tail and flag degenerate repetition. Two cheap tests run on
 * the trailing window, amortized to one pass per `checkEvery` characters:
 *
 * 1. **Line collapse** — many non-blank lines but only a couple of distinct
 *    ones. Catches the common "same sentence, over and over" failure.
 * 2. **Probe recurrence** — the last `probe` characters appearing `repeats`+
 *    times in the window. Catches cycles with no line breaks, and cycles
 *    shorter than the probe (which recur at every cycle boundary).
 *
 * Both need a decent volume of text first, so a model that legitimately repeats
 * a short phrase, or emits a few similar lines, is not cut off.
 */
export function createRunawayGuard(opts: RunawayOptions = {}): RunawayGuard {
  const o = { ...DEFAULTS, ...opts };
  let tail = '';
  let total = 0;
  let checkedAt = 0;
  let tripped = false;

  return {
    get tripped() {
      return tripped;
    },
    push(delta: string): boolean {
      if (tripped) return true;
      if (!delta) return false;
      total += delta.length;
      tail = (tail + delta).slice(-o.window);
      if (total < o.minChars || total - checkedAt < o.checkEvery) return false;
      checkedAt = total;
      tripped = looksLikeLoop(tail, o);
      return tripped;
    },
  };
}

/** Run both repetition tests over one trailing window. */
function looksLikeLoop(tail: string, o: Required<RunawayOptions>): boolean {
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length >= o.minLines && new Set(lines).size <= o.minDistinctLines) return true;

  if (tail.length < o.probe * 2) return false;
  const probe = tail.slice(-o.probe);
  let count = 0;
  let from = 0;
  while (from <= tail.length - o.probe) {
    const at = tail.indexOf(probe, from);
    if (at === -1) break;
    count++;
    if (count >= o.repeats) return true;
    from = at + 1; // overlapping matches count, so a sub-probe cycle still trips
  }
  return false;
}

/**
 * What the user sees when a reply is cut short for looping. Says what happened
 * and what actually helps, since the fix is a model/sampling change rather than
 * anything to retry blindly.
 */
export const RUNAWAY_NOTE =
  '_Stopped: the model got stuck repeating itself and stopped making progress. ' +
  'Nothing was lost: everything before the loop is above. ' +
  'This is usually the model rather than the prompt: try again, lower Effort, ' +
  'or switch to a different model if it keeps happening._';
