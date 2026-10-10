import type { SkillDef } from '@nekko-agent/shared';

/** Attaching a skill must not consume the prompt; only a lone slash query is consumed. */
export function draftAfterSkillSelection(draft: string, skill: SkillDef): string {
  // A lone slash query is a skill search, not a prompt. Checking the current
  // draft also keeps text typed after a stale menu was shown.
  if (/^\/\S*$/.test(draft)) return skill.kind === 'goal' ? '/goal ' : '';
  if (skill.kind !== 'goal') return draft;

  // Goal dispatch still uses the leading command, with the draft as its condition.
  return /^\/goal\s/i.test(draft) ? draft : `/goal ${draft}`;
}
