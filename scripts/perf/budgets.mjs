/**
 * The speed contract's budgets, as p95 in milliseconds. The source of truth is
 * the table under "Speed & responsiveness" in SPEC.md; keep the two in step.
 *
 * `target` is the product budget, met on a desktop at 120 Hz (8.3 ms is one
 * frame there). The GitHub `perf` job runs on a 4-vCPU runner with no GPU and a
 * 60 Hz display, where the same work takes about twice as long, so by default
 * a run is judged against `ci`, twice the target: a regression gate, one 60 Hz
 * frame for the frame-sized budgets. `--strict` (`npm run perf:strict`) judges
 * against the targets themselves, for runs on real hardware.
 */
export const BUDGETS = [
  { id: 'composer_keypress', label: 'Keypress to paint, chat composer, 1,000-message chat, reply streaming', target: 8.3, ci: 16.7 },
  { id: 'terminal_keypress', label: 'Keypress to paint, terminal', target: 8.3, ci: 16.7 },
  { id: 'stream_frame_work', label: 'Main-thread work per frame while a reply streams at 300 tokens/s', target: 4, ci: 8 },
  { id: 'warm_switch', label: 'Switch to a warm chat, to paint', target: 8.3, ci: 16.7 },
  { id: 'cold_switch_frame', label: 'Switch to a cold chat, frame painted', target: 8.3, ci: 16.7 },
  { id: 'cold_switch_history', label: 'Switch to a cold chat, newest screenful of history painted', target: 100, ci: 200 },
];
