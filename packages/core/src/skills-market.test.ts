import { describe, it, expect } from 'vitest';
import {
  MARKET_SKILLS,
  NEKKO_SKILLS,
  POPULAR_SKILLS,
  popularSkills,
  getMarketSkill,
  marketWorkflow,
  marketToSkillDef,
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
    const council = getMarketSkill('kotrain-review-council')!;
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
    const def = marketToSkillDef(getMarketSkill('kotrain-changelog')!);
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
    expect(md).toContain('Anthropic');
  });
});
