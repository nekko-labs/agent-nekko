/**
 * The budgets CI enforces, as p95 in milliseconds. The source of truth is the
 * table under "Speed & responsiveness" in SPEC.md; keep the two in step.
 */
export const BUDGETS = [
  { id: 'composer_keypress', label: 'Keypress to paint, chat composer, 1,000-message chat, reply streaming', budget: 8.3 },
  { id: 'terminal_keypress', label: 'Keypress to paint, terminal', budget: 8.3 },
  { id: 'stream_frame_work', label: 'Main-thread work per frame while a reply streams at 300 tokens/s', budget: 4 },
  { id: 'warm_switch', label: 'Switch to a warm chat, to paint', budget: 8.3 },
  { id: 'cold_switch_frame', label: 'Switch to a cold chat, frame painted', budget: 8.3 },
  { id: 'cold_switch_history', label: 'Switch to a cold chat, newest screenful of history painted', budget: 100 },
];
