import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat.js';
import { TurnStatsAccumulator, attachTurnStats, turnTokensPerSecond } from './turn-stats.js';

const msg = (id: string, role: ChatMessage['role']): ChatMessage => ({ id, role, content: id, createdAt: 1 });

describe('turn stats', () => {
  it('sums every model call in a reply and records model and effort', () => {
    const acc = new TurnStatsAccumulator({ providerId: 'chatgpt', modelId: 'gpt-6.1-sol', effort: 'high' }, 1_000);
    acc.add({ inputTokens: 1200, outputTokens: 80, cacheReadTokens: 4000, outputMs: 800 });
    acc.add({ inputTokens: 300, outputTokens: 120, cacheWriteTokens: 50, outputMs: 1200 });
    expect(acc.finish(11_000, { steps: 1, stop: 'complete' })).toEqual({
      providerId: 'chatgpt', modelId: 'gpt-6.1-sol', effort: 'high',
      inputTokens: 1500, outputTokens: 200, cacheReadTokens: 4000, cacheWriteTokens: 50,
      outputMs: 2000, wallMs: 10_000, calls: 2, steps: 1, stop: 'complete',
    });
  });

  it('reports nothing when no call reported usage', () => {
    expect(new TurnStatsAccumulator({ providerId: 'p', modelId: 'm' }, 0).finish(5)).toBeUndefined();
  });

  it('attaches to the last assistant message of this turn only', () => {
    const messages = [msg('u0', 'user'), msg('a0', 'assistant'), msg('u1', 'user'), msg('a1', 'assistant'), msg('t1', 'tool'), msg('a2', 'assistant')];
    const stats = new TurnStatsAccumulator({ providerId: 'p', modelId: 'm' }, 0);
    stats.add({ inputTokens: 1, outputTokens: 1 });
    expect(attachTurnStats(messages, 2, stats.finish(1)!)).toBe(true);
    expect(messages.map((m) => !!m.turnStats)).toEqual([false, false, false, false, false, true]);
    // A turn that produced no assistant message leaves earlier turns alone.
    expect(attachTurnStats(messages, 6, stats.finish(1)!)).toBe(false);
  });

  it('rates by decode time when known, else wall time', () => {
    expect(turnTokensPerSecond({ outputTokens: 200, outputMs: 2000, wallMs: 10_000 })).toBe(100);
    expect(turnTokensPerSecond({ outputTokens: 200, wallMs: 10_000 })).toBe(20);
    expect(turnTokensPerSecond({ outputTokens: 0, wallMs: 0 })).toBe(0);
  });
});
