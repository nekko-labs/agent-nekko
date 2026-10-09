import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareQuota } from './compare-quota.mjs';
const reply = { sessionId: 's', providerId: 'p', modelId: 'm', startedAt: 100, ts: 200, inputTokens: 20, cacheReadTokens: 80 };
const snap = (timestamp, usedPercent, resetsAt = 1000) => ({ timestamp, providerId: 'p', windows: [{ id: '5h', usedPercent, resetsAt }] });
test('compares observed percentage points and total input, without claiming billing', () => {
  const [r] = compareQuota([reply], [snap(90, 10), snap(210, 12)]);
  assert.equal(r.totalInputTokens, 100); assert.equal(r.cacheHitPercent, 80);
  assert.equal(r.quota.status, 'correlation-only'); assert.equal(r.quota.windows[0].usedPercentagePointChange, 2);
  assert.equal(r.quota.beforeGapMs, 10); assert.equal(r.quota.afterGapMs, 10);
});
test('flags overlapping replies and ignores other providers', () => {
  const other = { ...reply, sessionId: 'other', startedAt: 150, ts: 250 };
  assert.equal(compareQuota([reply, other, { ...other, providerId: 'q' }], [snap(90, 10), snap(260, 12)])[0].quota.otherRecordedRepliesInInterval, 1);
});
test('reset, decrease, and missing windows do not produce consumption deltas', () => {
  for (const after of [snap(210, 0), snap(210, 12, 2000), { ...snap(210, 12), windows: [] }]) {
    const w = compareQuota([reply], [snap(90, 10), after])[0].quota.windows[0];
    assert.equal(w.status, 'reset-or-window-changed'); assert.equal(w.usedPercentagePointChange, undefined);
  }
});
test('missing counters and snapshots stay unknown; old wall timing is usable', () => {
  const [r] = compareQuota([{ ts: 200, wallMs: 100, providerId: 'p' }], []);
  assert.equal(r.startedAt, 100); assert.equal(r.totalInputTokens, undefined);
  assert.equal(r.quota.status, 'missing-bracketing-snapshots');
  assert.equal(compareQuota([{ ts: 200, providerId: 'p' }], [snap(90, 1), snap(210, 2)])[0].quota.status, 'missing-bracketing-snapshots');
});
