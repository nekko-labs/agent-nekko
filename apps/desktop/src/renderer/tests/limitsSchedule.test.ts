import { expect, it } from 'vitest';
import { limitsRefreshInterval, nextLimitsRefresh } from '../limitsSchedule.js';
it('refreshes only an active subscription twice as fast', () => {
  expect(limitsRefreshInterval(false)).toBe(60000);
  expect(limitsRefreshInterval(true)).toBe(30000);
  const reads = new Map([['chatgpt', 1000], ['claude', 1000]]);
  expect(nextLimitsRefresh(['claude'], reads, new Set(['chatgpt']), 1000)).toBe(61000);
  expect(nextLimitsRefresh(['claude', 'chatgpt'], reads, new Set(['chatgpt']), 1000)).toBe(31000);
  expect(nextLimitsRefresh([], reads, new Set(), 1000)).toBeNull();
});
