import { afterEach, expect, it, vi } from 'vitest';
import { applyEvent, getLiveRun, __resetLiveRuns } from '../../liveRuns.js';
import { liveTokenRate } from './liveTokenRate.js';

vi.stubGlobal('requestAnimationFrame', () => 0);
vi.stubGlobal('cancelAnimationFrame', () => {});
afterEach(() => { __resetLiveRuns(); vi.useRealTimers(); });
it('shows a provisional rate before usage, excluding initial prompt latency and idle waits', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  applyEvent({ type: 'text', sessionId: 'a', delta: 'abcdefgh' });
  expect(liveTokenRate(getLiveRun('a'))).toBeNull();
  vi.setSystemTime(11000);
  applyEvent({ type: 'reasoning', sessionId: 'a', delta: 'abcdefgh' });
  expect(liveTokenRate(getLiveRun('a'))?.rate).toBe(4);
  vi.setSystemTime(60000);
  expect(liveTokenRate(getLiveRun('a'))?.rate).toBe(4);
  applyEvent({ type: 'usage', sessionId: 'a', inputTokens: 100, outputTokens: 10, outputMs: 1000 });
  expect(liveTokenRate(getLiveRun('a'))).toBeNull();
  expect(getLiveRun('a')?.outputTokens).toBe(10);
});
it('drops retry output and starts a fresh timing window after tool waits', () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  applyEvent({ type: 'text', sessionId: 'a', delta: 'abcdefgh' });
  applyEvent({ type: 'retry', sessionId: 'a', attempt: 2, maxAttempts: 3, delayMs: 1000, reason: 'busy' });
  expect(liveTokenRate(getLiveRun('a'))).toBeNull();
  vi.setSystemTime(20000); applyEvent({ type: 'text', sessionId: 'a', delta: 'abcd' });
  vi.setSystemTime(21000); applyEvent({ type: 'text', sessionId: 'a', delta: 'abcd' });
  expect(liveTokenRate(getLiveRun('a'))?.rate).toBe(2);
  applyEvent({ type: 'tool_call', sessionId: 'a', call: { id: 'tool', name: 'read_file', input: {} } });
  expect(liveTokenRate(getLiveRun('a'))).toBeNull();
  vi.setSystemTime(90000); applyEvent({ type: 'text', sessionId: 'a', delta: 'abcd' });
  vi.setSystemTime(91000); applyEvent({ type: 'text', sessionId: 'a', delta: 'abcd' });
  expect(liveTokenRate(getLiveRun('a'))?.rate).toBe(2);
});
