/**
 * Times the decode phase of one streamed response, for the tokens/second figure.
 *
 * Throughput is tokens divided by the time spent *generating* them. The wall
 * clock of a turn is not that: it also covers queueing, prompt processing (which
 * on a local model with a long context can be most of the wait), the tool calls
 * the agent runs between responses, and any approval the user sat on. Dividing
 * by that gives a number several times below what the runtime itself reports,
 * which is what made Agent Nekko's tok/s wrong.
 *
 * So the clock starts at the first generated chunk, not at the request, and
 * stops when usage arrives at the end of the stream. Providers that report their
 * own decode time (Ollama's `eval_duration`) should use that instead: it is
 * measured inside the runtime and excludes transport entirely.
 */
export class DecodeClock {
  private startedAt = 0;
  private stoppedAt = 0;

  /** Call on every generated chunk (text, reasoning, or tool-call arguments). */
  mark(): void {
    if (!this.startedAt) this.startedAt = Date.now();
  }

  /** Freeze the clock, so a usage chunk that trails the stream doesn't inflate it. */
  stop(): void {
    if (this.startedAt && !this.stoppedAt) this.stoppedAt = Date.now();
  }

  /**
   * Decode milliseconds so far, or undefined when nothing was generated. A single
   * chunk arriving in under a millisecond still counts as 1ms, so a fast, tiny
   * response reports a bounded rate instead of dividing by zero.
   */
  elapsed(): number | undefined {
    if (!this.startedAt) return undefined;
    return Math.max(1, (this.stoppedAt || Date.now()) - this.startedAt);
  }
}
