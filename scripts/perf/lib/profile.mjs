/**
 * CPU profiles for chasing a regression the report points at: --profile wraps
 * each measured phase in a V8 sampling profile, writes it (open it in the
 * DevTools Performance panel) and prints where the self time went.
 */
import { closeSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export async function startProfile(cdp) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
  await cdp.send('Profiler.start');
}

export async function stopProfile(cdp, outDir, name) {
  const { profile } = await cdp.send('Profiler.stop');
  writeFileSync(join(outDir, `${name}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas ?? [];
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const file = (f.url || '').split('/').pop();
    const key = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const top = [...self.entries()]
    .filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25);
  console.log(`[perf] ${name}: top self time`);
  for (const [k, ms] of top) console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${k}`);
}

/**
 * A DevTools timeline trace of a phase, summarized as main-thread time per
 * event kind (script, style, layout, paint...), for time the CPU profile
 * cannot see because it is not JavaScript.
 */
export async function startTimeline(cdp) {
  const events = [];
  // Main-thread work only: a phase with frames running flat out is otherwise
  // more trace than fits in memory.
  const keep = new Set(['ThreadControllerImpl::RunTask', 'EventDispatch', 'FunctionCall', 'TimerFire', 'FireAnimationFrame', 'RunMicrotasks',
    'UpdateLayoutTree', 'Layout', 'HitTest', 'PrePaint', 'Paint', 'Layerize', 'UpdateLayer']);
  const off = cdp.on('Tracing.dataCollected', (p) => { for (const e of p.value) if (e.ph === 'M' || keep.has(e.name)) events.push(e); });
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordContinuously', includedCategories: ['devtools.timeline', 'toplevel', '__metadata'] },
  });
  return async (outDir, name) => {
    const done = new Promise((r) => { const o = cdp.on('Tracing.tracingComplete', () => { o(); r(); }); });
    await cdp.send('Tracing.end');
    await done;
    off();
    // Written event by event: a long phase is more than one JSON string can hold.
    const fd = openSync(join(outDir, `${name}.trace.json`), 'w');
    writeSync(fd, '{"traceEvents":[');
    events.forEach((e, i) => writeSync(fd, (i ? ',' : '') + JSON.stringify(e)));
    writeSync(fd, ']}');
    closeSync(fd);
    const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain');
    const totals = new Map();
    for (const e of events) {
      if (!main || e.tid !== main.tid || e.pid !== main.pid || e.ph !== 'X' || !e.dur) continue;
      totals.set(e.name, (totals.get(e.name) ?? 0) + e.dur / 1000);
    }
    console.log(`[perf] ${name}: main-thread time by event (nested events overlap)`);
    for (const [k, ms] of [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${ms.toFixed(1).padStart(8)} ms  ${k}`);
  };
}
