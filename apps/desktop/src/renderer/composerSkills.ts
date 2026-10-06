import type { SkillDef } from '@agent-nekko/shared';

export type SkillSelectionSource = 'attach-menu' | 'slash-menu';

/** Attaching a skill must not consume the prompt; only slash search consumes its query. */
export function draftAfterSkillSelection(draft: string, skill: SkillDef, source: SkillSelectionSource): string {
  // A stale menu click must not erase text typed since the slash query was shown.
  if (source === 'slash-menu' && /^\/[^\s]*$/.test(draft)) return skill.kind === 'goal' ? '/goal ' : '';
  if (skill.kind !== 'goal') return draft;
  // Goal dispatch still uses the leading command, with the draft as its condition.
  return /^\/goal(?:\s|$)/i.test(draft) ? draft : `/goal ${draft}`;
}
