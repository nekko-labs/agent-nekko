/** Per-reply measurements: accumulated while a turn runs, kept on its last message. */

import type { ChatMessage, TurnStats } from './chat.js';
import type { EffortLevel } from './settings.js';

/** A running total for one turn. Feed it every `usage` event, then `finish`. */
export class TurnStatsAccumulator {
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private outputMs = 0;
  private timed = false;
  private calls = 0;

  constructor(
    private readonly identity: { providerId: string; modelId: string; effort?: EffortLevel },
    private readonly startedAt: number,
  ) {}

  add(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputMs?: number }): void {
    this.calls++;
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    if (usage.outputMs != null && usage.outputMs > 0) { this.outputMs += usage.outputMs; this.timed = true; }
  }

  /** The finished stats, or undefined when no model call reported usage. */
  finish(endedAt: number, end?: { steps?: number; stop?: TurnStats['stop'] }): TurnStats | undefined {
    if (this.calls === 0) return undefined;
    return {
      ...this.identity,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheReadTokens ? { cacheReadTokens: this.cacheReadTokens } : {}),
      ...(this.cacheWriteTokens ? { cacheWriteTokens: this.cacheWriteTokens } : {}),
      ...(this.timed ? { outputMs: this.outputMs } : {}),
      wallMs: Math.max(0, endedAt - this.startedAt),
      calls: this.calls,
      ...(end?.steps != null ? { steps: end.steps } : {}),
      ...(end?.stop ? { stop: end.stop } : {}),
    };
  }
}

/**
 * Put a turn's stats on the message that ends it: the last assistant message
 * after `fromIndex` (the turn's first new message). Returns false when the
 * turn produced no assistant message to carry them.
 */
export function attachTurnStats(messages: ChatMessage[], fromIndex: number, stats: TurnStats): boolean {
  for (let i = messages.length - 1; i >= Math.max(0, fromIndex); i--) {
    if (messages[i].role === 'assistant') {
      messages[i] = { ...messages[i], turnStats: stats };
      return true;
    }
  }
  return false;
}

/** Output tokens per second over decode time, falling back to wall time. */
export function turnTokensPerSecond(stats: Pick<TurnStats, 'outputTokens' | 'outputMs' | 'wallMs'>): number {
  const ms = stats.outputMs && stats.outputMs > 0 ? stats.outputMs : stats.wallMs;
  return ms > 0 ? stats.outputTokens / (ms / 1000) : 0;
}
