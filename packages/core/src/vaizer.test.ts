import { describe, it, expect } from 'vitest';
import {
  VAIZER_SNAPSHOT,
  VAIZER_CATALOG_URL,
  vaizerSkillMdUrl,
  vaizerCategory,
  vaizerToMarketSkill,
  splitSkillMd,
  skillToMarkdown,
  marketToSkillDef,
  marketWorkflow,
  layoutWorkflow,
  MARKET_SKILLS,
} from '@agent-nekko/shared';

describe('vaizer catalog snapshot', () => {
  it('bundled snapshot is well-formed and offline-marked', () => {
    expect(VAIZER_SNAPSHOT.source).toBe('bundled');
    expect(VAIZER_SNAPSHOT.skills.length).toBeGreaterThan(0);
    for (const s of VAIZER_SNAPSHOT.skills) {
      expect(s.slug).toMatch(/^[a-z0-9-]+$/);
      expect(['kotrain-official', 'community']).toContain(s.tier);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });

  it('snapshot ids do not collide with the built-in marketplace catalog', () => {
    const builtin = new Set(MARKET_SKILLS.map((s) => s.id));
    for (const s of VAIZER_SNAPSHOT.skills) expect(builtin.has(`vaizer-${s.id}`)).toBe(false);
  });

  it('urls point at the vaizer repo raw content', () => {
    expect(VAIZER_CATALOG_URL).toContain('nekko-labs/vaizer');
    expect(vaizerSkillMdUrl('nyaa')).toBe(
      'https://raw.githubusercontent.com/nekko-labs/vaizer/main/plugins/vaizer/skills/nyaa/SKILL.md',
    );
  });
});

describe('vaizerCategory', () => {
  it('maps vaizer categories onto Kotrain skill categories', () => {
    expect(vaizerCategory('research')).toBe('Research & planning');
    expect(vaizerCategory('engineering')).toBe('Code quality');
    expect(vaizerCategory('delivery')).toBe('Delivery');
    // `career` (resume-checker) has no Kotrain equivalent; it reads as analysis work.
    expect(vaizerCategory('career')).toBe('Research & planning');
    expect(vaizerCategory('something-else')).toBe('Automation');
  });
});

describe('splitSkillMd', () => {
  it('strips YAML frontmatter', () => {
    const md = '---\nname: nyaa\ndescription: cats\n---\n\n# nyaa\n\nBody here.';
    const { frontmatter, body } = splitSkillMd(md);
    expect(frontmatter).toContain('name: nyaa');
    expect(body.startsWith('# nyaa')).toBe(true);
  });

  it('passes through content with no frontmatter', () => {
    expect(splitSkillMd('just text').body).toBe('just text');
  });
});

describe('vaizerToMarketSkill', () => {
  const entry = VAIZER_SNAPSHOT.skills[0];

  it('produces a valid marketplace skill with vaizer provenance', () => {
    const m = vaizerToMarketSkill(entry);
    expect(m.id).toBe(`vaizer-${entry.id}`);
    expect(m.name).toBe(entry.slug);
    expect(m.source).toBe('vaizer');
    expect(m.tier).toBe(entry.tier);
    expect(m.template.length).toBeGreaterThan(0);
    expect(m.instructions.length).toBeGreaterThan(0);
    // Runnable in-app + layoutable workflow, same as any marketplace skill.
    const def = marketToSkillDef(m);
    const layout = layoutWorkflow(marketWorkflow(m));
    expect(def.name).toBe(m.name);
    expect(layout.nodes.length).toBeGreaterThan(2);
  });

  it('carries a fetched SKILL.md verbatim into file-based installs', () => {
    const md = '---\nname: nyaa\ndescription: cats\n---\n\n# nyaa\n\nFull real instructions.';
    const m = vaizerToMarketSkill(entry, md);
    expect(m.markdown).toBe(md);
    expect(m.instructions).toContain('Full real instructions.');
    // skillToMarkdown must write the verbatim file, not a generated summary.
    expect(skillToMarkdown(m)).toBe(`${md}\n`);
  });

  it('falls back to the catalog description when no SKILL.md is available', () => {
    const m = vaizerToMarketSkill(entry);
    expect(m.markdown).toBeUndefined();
    expect(m.instructions).toBe(entry.description);
    // Generated SKILL.md path still works.
    expect(skillToMarkdown(m)).toContain(`name: ${entry.slug}`);
  });
});
