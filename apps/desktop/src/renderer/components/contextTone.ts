/**
 * The colour a context window earns by how full it is: quiet grey while there
 * is room, yellow as it nears the edge, red once it is effectively full. Only
 * the last two are worth the eye's attention, so only they get a hue.
 */
export function fillTone(percent: number): string {
  if (percent >= 90) return 'var(--danger)';
  if (percent >= 70) return 'var(--warning)';
  return 'var(--ink-faint)';
}
