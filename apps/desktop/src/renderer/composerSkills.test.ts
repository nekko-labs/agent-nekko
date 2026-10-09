import { describe, expect, it } from 'vitest';
import { SKILLS, type SkillDef } from '@nekko-agent/shared';
import { draftAfterSkillSelection } from './composerSkills.js';

const plan = SKILLS.find((skill) => skill.name === 'plan')!;
const goal = SKILLS.find((skill) => skill.kind === 'goal')!;

describe('composer skill selection', () => {
  it.each(['Write an implementation plan', '# Prompt\n\n- Keep my text\n- café 🐱\n  ', '', '   ', '/goal investigate'])
    ('preserves the exact draft when adding Plan: %j', (draft) => {
      expect(plan).toBeDefined();
      expect(draftAfterSkillSelection(draft, plan)).toBe(draft);
    });

  it('preserves text when replacing Plan with another or an installed skill', () => {
    const installed: SkillDef = { ...plan, id: 'installed', name: 'custom-plan' };
    const draft = 'Do not replace this prompt.\n';
    for (const skill of [...SKILLS.filter((sk) => sk.kind !== 'goal'), installed]) {
      expect(draftAfterSkillSelection(draftAfterSkillSelection(draft, plan), skill)).toBe(draft);
    }
  });

  it.each(['/', '/p', '/plan', '/review'])('consumes a lone slash query instead of sending it: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, plan)).toBe('');
  });

  it.each(['New prompt typed after the menu opened', '/plan investigate checkout', '/plan\nKeep these details'])
    ('does not erase unrelated text on a stale slash-menu selection: %j', (draft) => {
      expect(draftAfterSkillSelection(draft, plan)).toBe(draft);
    });

  it('keeps the entire draft as the goal condition', () => {
    const draft = 'Fix checkout\n\nKeep investigating until tests pass.  ';
    expect(draftAfterSkillSelection(draft, goal)).toBe(`/goal ${draft}`);
  });

  it.each(['/goal Fix checkout', '/GOAL\nFix checkout'])('does not duplicate a goal prefix: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, goal)).toBe(draft);
  });

  it.each(['', '/go', '/goal', '/GOAL'])('leaves a ready goal prefix for an empty draft or slash query: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, goal)).toBe('/goal ');
  });

  it('does not mistake a similarly named word for the goal command', () => {
    expect(draftAfterSkillSelection('/goals matter', goal)).toBe('/goal /goals matter');
  });
});
