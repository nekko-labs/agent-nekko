import { describe, expect, it } from 'vitest';
import { SKILLS, type SkillDef } from '@agent-nekko/shared';
import { draftAfterSkillSelection } from './composerSkills.js';

const plan = SKILLS.find((skill) => skill.name === 'plan')!;
const goal = SKILLS.find((skill) => skill.kind === 'goal')!;

describe('composer skill selection', () => {
  it.each(['Write an implementation plan', '# Prompt\n\n- Keep my text\n- café 🐱\n  ', '', '   ', '/plan', '/goal investigate'])
    ('preserves the exact draft when adding Plan through the + menu: %j', (draft) => {
      expect(plan).toBeDefined();
      expect(draftAfterSkillSelection(draft, plan, 'attach-menu')).toBe(draft);
    });

  it('preserves text when replacing Plan with another or an installed skill', () => {
    const installed: SkillDef = { ...plan, id: 'installed', name: 'custom-plan' };
    const draft = 'Do not replace this prompt.\n';
    for (const skill of [...SKILLS.filter((sk) => sk.kind !== 'goal'), installed]) {
      expect(draftAfterSkillSelection(draftAfterSkillSelection(draft, plan, 'attach-menu'), skill, 'attach-menu')).toBe(draft);
    }
  });

  it.each(['/p', '/plan', '/review'])('consumes the slash-menu search instead of sending it: %s', (draft) => {
    expect(draftAfterSkillSelection(draft, plan, 'slash-menu')).toBe('');
  });

  it.each(['New prompt typed after the menu opened', '/plan investigate checkout', '/plan\nKeep these details'])
    ('does not erase unrelated text on a stale slash-menu selection: %j', (draft) => {
      expect(draftAfterSkillSelection(draft, plan, 'slash-menu')).toBe(draft);
    });

  it('keeps the entire draft as the goal condition', () => {
    const draft = 'Fix checkout\n\nKeep investigating until tests pass.  ';
    expect(draftAfterSkillSelection(draft, goal, 'attach-menu')).toBe(`/goal ${draft}`);
  });

  it.each(['/goal Fix checkout', '/GOAL\nFix checkout', '/goal'])('does not duplicate a goal prefix: %j', (draft) => {
    expect(draftAfterSkillSelection(draft, goal, 'attach-menu')).toBe(draft);
  });

  it('does not mistake a similarly named word for the goal command', () => {
    expect(draftAfterSkillSelection('/goals matter', goal, 'attach-menu')).toBe('/goal /goals matter');
  });

  it('retains the existing empty goal/slash selection behavior', () => {
    expect(draftAfterSkillSelection('', goal, 'attach-menu')).toBe('/goal ');
    expect(draftAfterSkillSelection('/go', goal, 'slash-menu')).toBe('/goal ');
  });
});
