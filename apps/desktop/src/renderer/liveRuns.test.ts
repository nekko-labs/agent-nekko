import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-nekko/shared';
import { __resetLiveRuns, applyEvent, clearLiveRun, getLiveRun, runningSessionIds } from './liveRuns.js';

// The registry repaints on an animation frame; the folding itself is synchronous
// and is what these tests are about, so the scheduler is stubbed out.
vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});

const text = (sessionId: string, delta: string): AgentEvent => ({ type: 'text', sessionId, delta });
const call = (sessionId: string, name: string): AgentEvent => ({
  type: 'tool_call',
  sessionId,
  call: { id: `c_${name}`, name, input: {} },
});

describe('liveRuns', () => {
  beforeEach(() => __resetLiveRuns());

  it('accumulates a reply across events', () => {
    applyEvent(text('a', 'Hello'));
    applyEvent(text('a', ' world'));
    expect(getLiveRun('a')?.text).toBe('Hello world');
  });

  it('keeps a run alive with no component watching it', () => {
    // This is the whole point: the chat pane used to own the only subscription,
    // so switching workspaces unmounted it and the turn's output went nowhere.
    // Nothing here has ever rendered, and the run is still complete.
    applyEvent(text('a', 'part one'));
    applyEvent(call('a', 'read_file'));
    applyEvent(text('a', ' part two'));

    const run = getLiveRun('a');
    expect(run?.text).toBe('part one part two');
    expect(run?.tools.map((t) => t.name)).toEqual(['read_file']);
  });

  it('keeps several sessions running at once without mixing them', () => {
    applyEvent(text('a', 'alpha'));
    applyEvent(text('b', 'beta'));
    applyEvent(text('a', '!'));

    expect(getLiveRun('a')?.text).toBe('alpha!');
    expect(getLiveRun('b')?.text).toBe('beta');
    expect(runningSessionIds().sort()).toEqual(['a', 'b']);
  });

  it('drops the run when the turn finishes, so the stored transcript takes over', () => {
    applyEvent(text('a', 'done soon'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm1' });
    expect(getLiveRun('a')).toBeUndefined();
  });

  it('drops the run on an error too', () => {
    applyEvent(text('a', 'partial'));
    applyEvent({ type: 'error', sessionId: 'a', message: 'boom' });
    expect(getLiveRun('a')).toBeUndefined();
  });

  it('ends one session without disturbing another still running', () => {
    applyEvent(text('a', 'alpha'));
    applyEvent(text('b', 'beta'));
    applyEvent({ type: 'done', sessionId: 'a', messageId: 'm1' });

    expect(getLiveRun('a')).toBeUndefined();
    expect(getLiveRun('b')?.text).toBe('beta');
  });

  it('sums usage across a turn\'s steps rather than replacing it', () => {
    // A multi-step turn reports usage per step; the rate is over the whole turn.
    applyEvent({ type: 'usage', sessionId: 'a', inputTokens: 100, outputTokens: 10, outputMs: 500 });
    applyEvent({ type: 'usage', sessionId: 'a', inputTokens: 200, outputTokens: 30, outputMs: 1_000 });

    const run = getLiveRun('a');
    expect(run?.outputTokens).toBe(40);
    expect(run?.inputTokens).toBe(300);
    expect(run?.decodeMs).toBe(1_500);
  });

  it('measures how long the model spent reasoning, closed out by its answer', () => {
    applyEvent({ type: 'reasoning', sessionId: 'a', delta: 'hmm' }, 1_000);
    applyEvent(text('a', 'answer'), 3_500);
    expect(getLiveRun('a')?.reasoningMs).toBe(2_500);
    // Closed out, so the pane does not keep showing a thinking indicator.
    expect(getLiveRun('a')?.reasoningStartedAt).toBe(0);
  });

  it('folds the step rail alongside the raw text', () => {
    applyEvent(call('a', 'grep'));
    const steps = getLiveRun('a')?.activity.steps ?? [];
    expect(steps.at(-1)).toMatchObject({ kind: 'tool', label: 'grep', status: 'running' });
  });

  it('lets a pane retire a run it has folded into the transcript', () => {
    applyEvent(text('a', 'x'));
    clearLiveRun('a');
    expect(getLiveRun('a')).toBeUndefined();
  });

  it('ignores a clear for a session that is not running', () => {
    expect(() => clearLiveRun('nobody')).not.toThrow();
  });
});
