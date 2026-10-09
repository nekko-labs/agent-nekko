import { describe, it, expect } from 'vitest';
import {
  MARKET_SKILLS,
  NEKKO_SKILLS,
  POPULAR_SKILLS,
  popularSkills,
  getMarketSkill,
  marketWorkflow,
  marketToSkillDef,
  marketSkillInstructions,
  skillToMarkdown,
  layoutWorkflow,
  SKILLS,
} from '@agent-nekko/shared';

describe('skills marketplace catalog', () => {
  it('has unique ids and names across the whole catalog', () => {
    const ids = MARKET_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = MARKET_SKILLS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marketplace names do not collide with built-in skills', () => {
    const builtin = new Set(SKILLS.map((s) => s.name));
    for (const s of MARKET_SKILLS) expect(builtin.has(s.name)).toBe(false);
  });

  it('every skill carries the fields the UI and installers need', () => {
    for (const s of MARKET_SKILLS) {
      expect(s.template.length).toBeGreaterThan(0);
      expect(s.instructions.length).toBeGreaterThan(20);
      expect(s.author.length).toBeGreaterThan(0);
    }
    for (const s of NEKKO_SKILLS) expect(s.source).toBe('nekkolabs');
    for (const s of POPULAR_SKILLS) expect(s.source).toBe('community');
  });

  it('credits every catalog entry to Nekko Labs, who wrote its text', () => {
    // The catalog's instructions are all our own words. A skill summarising
    // someone else's links it as `basedOn`; it is never credited to them.
    for (const s of MARKET_SKILLS) expect(s.author, s.id).toBe('Nekko Labs');
  });

  it('links each popular entry to the original it is based on, not as its homepage', () => {
    for (const s of POPULAR_SKILLS) {
      expect(s.basedOn, s.id).toMatch(/^https:\/\//);
      expect(s.url, s.id).toBeUndefined();
    }
  });

  it('only points at an anthropics/skills skill that exists, and only as a reference', () => {
    // i18n-sweep used to link anthropics/skills, which has no such skill.
    const anthropic = MARKET_SKILLS.filter((s) => `${s.url ?? ''} ${s.basedOn ?? ''}`.includes('anthropics/skills'));
    expect(anthropic.map((s) => s.name).sort()).toEqual(['docx', 'pdf', 'xlsx']);
    for (const s of anthropic) expect(s.basedOn).toBe(`https://github.com/anthropics/skills/tree/main/skills/${s.name}`);
  });

  it('ranks the popular shelf by stars', () => {
    const shelf = popularSkills();
    for (let i = 1; i < shelf.length; i++) {
      expect((shelf[i - 1].stars ?? 0) >= (shelf[i].stars ?? 0)).toBe(true);
    }
  });

  it('getMarketSkill finds by id and misses unknowns', () => {
    expect(getMarketSkill(MARKET_SKILLS[0].id)?.id).toBe(MARKET_SKILLS[0].id);
    expect(getMarketSkill('nope')).toBeUndefined();
  });
});

describe('marketWorkflow', () => {
  it('keeps a bespoke workflow when present', () => {
    const council = getMarketSkill('agent-nekko-review-council')!;
    expect(marketWorkflow(council)).toBe(council.workflow);
  });

  it('derives a valid, layoutable graph for skills without one', () => {
    for (const s of MARKET_SKILLS) {
      const wf = marketWorkflow(s);
      const ids = new Set(wf.nodes.map((n) => n.id));
      for (const e of wf.edges) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
      expect(wf.nodes.some((n) => n.kind === 'trigger')).toBe(true);
      expect(wf.nodes.some((n) => n.kind === 'output')).toBe(true);
      const layout = layoutWorkflow(wf);
      expect(layout.nodes.length).toBe(wf.nodes.length);
      expect(layout.width).toBeGreaterThan(0);
    }
  });
});

describe('install artifacts', () => {
  it('marketToSkillDef produces a runnable in-app skill', () => {
    const def = marketToSkillDef(getMarketSkill('agent-nekko-changelog')!);
    expect(def.name).toBe('changelog');
    expect(def.template.length).toBeGreaterThan(0);
    expect(def.workflow.nodes.length).toBeGreaterThan(2);
  });

  it('skillToMarkdown writes SKILL.md frontmatter + instructions', () => {
    const md = skillToMarkdown(getMarketSkill('anthropic-pdf')!);
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('name: pdf');
    expect(md).toContain('description: ');
    expect(md).toContain('# pdf');
  });

  it('skillToMarkdown credits our summary to Nekko Labs and links the original as a reference', () => {
    const md = skillToMarkdown(getMarketSkill('anthropic-pdf')!);
    expect(md).toContain('author: Nekko Labs');
    expect(md).not.toContain('author: Anthropic');
    expect(md).toContain('Based on https://github.com/anthropics/skills/tree/main/skills/pdf');
  });

  it('skillToMarkdown adds no "based on" line for our own skills', () => {
    expect(skillToMarkdown(getMarketSkill('agent-nekko-changelog')!)).not.toContain('Based on');
  });
});

describe('full instructions reach the model', () => {
  it('a catalog skill sends its instructions, with the template as the task', () => {
    const m = getMarketSkill('agent-nekko-changelog')!;
    const def = marketToSkillDef(m);
    expect(def.template).toContain(m.instructions);
    expect(def.template).toContain(m.template);
    // Instructions first, template last so the user's input follows it.
    expect(def.template.indexOf(m.instructions)).toBeLessThan(def.template.indexOf(m.template));
    expect(def.template.endsWith(m.template)).toBe(true);
  });

  it('every installed catalog skill carries its instructions', () => {
    for (const m of MARKET_SKILLS) expect(marketToSkillDef(m).template).toContain(m.instructions);
  });

  it('a skill with no extra instructions runs on its template alone', () => {
    const m = { ...getMarketSkill('agent-nekko-standup')!, instructions: '' };
    expect(marketToSkillDef(m).template).toBe(m.template);
    expect(marketSkillInstructions(m)).toBe('');
  });
});
