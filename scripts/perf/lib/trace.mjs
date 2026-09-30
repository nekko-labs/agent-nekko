/**
 * Main-thread work per frame, from a DevTools trace.
 *
 * The page's main thread is the CrRendererMain with the most top-level task
 * time. Its busy time is the union of its top-level tasks (nested tasks are
 * folded in, not double-counted). Frames are the renderer's own
 * `AnimationFrame` spans, the same frames the Long Animation Frames API
 * reports: each frame's work is the busy time from its start to the next
 * frame's start, which covers the event handling that led to it, the rAF
 * callbacks, and style, layout and paint.
 */

const FALLBACK_SLOT_US = 16_667;

function mergeIntervals(list) {
  const sorted = list.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Busy microseconds of `intervals` (merged, sorted) inside [from, to). */
function busyIn(intervals, from, to, cursor) {
  let busy = 0;
  let i = cursor.i;
  while (i < intervals.length && intervals[i][1] <= from) i++;
  cursor.i = i;
  for (let j = i; j < intervals.length && intervals[j][0] < to; j++) {
    busy += Math.min(to, intervals[j][1]) - Math.max(from, intervals[j][0]);
  }
  return Math.max(0, busy);
}

export function frameWorkFromTrace(events) {
  const mains = new Set(
    events.filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain').map((e) => `${e.pid}:${e.tid}`),
  );
  const tasksBy = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || !String(e.cat).split(',').includes('toplevel')) continue;
    const key = `${e.pid}:${e.tid}`;
    if (!mains.has(key)) continue;
    let list = tasksBy.get(key);
    if (!list) tasksBy.set(key, (list = []));
    list.push([e.ts, e.ts + (e.dur ?? 0)]);
  }
  let main = null;
  let most = -1;
  for (const [key, list] of tasksBy) {
    const total = list.reduce((n, [s, e]) => n + (e - s), 0);
    if (total > most) { most = total; main = key; }
  }
  if (!main) return { work: [], frames: 0, source: 'no renderer main thread in trace', busyFraction: 0 };

  const tasks = mergeIntervals(tasksBy.get(main));
  const starts = events
    .filter((e) => e.name === 'AnimationFrame' && e.ph === 'b' && `${e.pid}:${e.tid}` === main)
    .map((e) => e.ts)
    .sort((a, b) => a - b);

  const work = [];
  const cursor = { i: 0 };
  let source;
  if (starts.length >= 2) {
    source = 'AnimationFrame spans';
    for (let k = 0; k + 1 < starts.length; k++) work.push(busyIn(tasks, starts[k], starts[k + 1], cursor) / 1000);
  } else {
    source = 'fixed 16.7 ms slots (no AnimationFrame events in this browser)';
    const from = tasks[0][0];
    const to = tasks[tasks.length - 1][1];
    for (let s = from; s < to; s += FALLBACK_SLOT_US) work.push(busyIn(tasks, s, s + FALLBACK_SLOT_US, cursor) / 1000);
  }
  const span = tasks[tasks.length - 1][1] - tasks[0][0];
  const busy = tasks.reduce((n, [s, e]) => n + (e - s), 0);
  return { work, frames: work.length, source, busyFraction: span > 0 ? busy / span : 0 };
}
