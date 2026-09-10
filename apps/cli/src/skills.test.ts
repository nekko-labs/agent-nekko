import { describe, expect, it } from 'vitest';
import { VAIZER_SNAPSHOT, getMarketSkill } from '@agent-nekko/shared';
import type { VaizerCatalog } from '@agent-nekko/shared';
import { resolveInstall, type SkillResolverClient } from './skills.js';

const SKILL_MD = `---
name: nyaa
description: Council of reviewer cats.
---

# nyaa

Convene the council.`;

function stubClient(over: Partial<SkillResolverClient> = {}): SkillResolverClient {
  return {
    vaizerCatalog: async () => VAIZER_SNAPSHOT,
    vaizerSkillMd: async () => SKILL_MD,
    ...over,
  };
}

describe('resolveInstall', () => {
  it('passes built-in catalog skills straight through with no payload', async () => {
    const builtIn = 'kotrain-review-council';
    expect(getMarketSkill(builtIn)).toBeDefined();

    const res = await resolveInstall(stubClient(), builtIn);

    expect(res).toEqual({ skillId: builtIn });
  });

  it('resolves a Vaizer skill by its friendly slug, which is what vaizer.app publishes', async () => {
    const res = await resolveInstall(stubClient(), 'nyaa');

    // The regression this guards: without a payload the host answers
    // "Unknown skill." because Vaizer skills are not in MARKET_SKILLS.
    expect(res.payload).toBeDefined();
    expect(res.skillId).toBe('vaizer-nyaa');
    expect(res.payload?.id).toBe('vaizer-nyaa');
    expect(res.payload?.name).toBe('nyaa');
    expect(res.payload?.source).toBe('vaizer');
  });

  it('also accepts the canonical vaizer- prefixed id the desktop shelf uses', async () => {
    const bySlug = await resolveInstall(stubClient(), 'nyaa');
    const byId = await resolveInstall(stubClient(), 'vaizer-nyaa');

    expect(byId.skillId).toBe(bySlug.skillId);
    expect(byId.payload?.id).toBe(bySlug.payload?.id);
  });

  it('carries the real SKILL.md so file installs get the skill, not the summary', async () => {
    const res = await resolveInstall(stubClient(), 'nyaa');

    expect(res.payload?.markdown).toBe(SKILL_MD);
    // Frontmatter is stripped for the instructions body.
    expect(res.payload?.instructions).toContain('Convene the council.');
    expect(res.payload?.instructions).not.toContain('name: nyaa');
  });

  it('still installs from the catalog summary when SKILL.md cannot be fetched', async () => {
    const offline = stubClient({ vaizerSkillMd: async () => null });

    const res = await resolveInstall(offline, 'nyaa');

    expect(res.skillId).toBe('vaizer-nyaa');
    expect(res.payload?.markdown).toBeUndefined();
    expect(res.payload?.instructions).toBeTruthy();
  });

  it('survives a rejected SKILL.md fetch rather than failing the install', async () => {
    const flaky = stubClient({
      vaizerSkillMd: async () => {
        throw new Error('network down');
      },
    });

    const res = await resolveInstall(flaky, 'nyaa');

    expect(res.skillId).toBe('vaizer-nyaa');
    expect(res.payload).toBeDefined();
  });

  it('falls back to the id when the catalog itself is unreachable', async () => {
    const noCatalog = stubClient({
      vaizerCatalog: async () => {
        throw new Error('offline');
      },
    });

    const res = await resolveInstall(noCatalog, 'nyaa');

    // No payload invented: the host gets the id and reports its own error.
    expect(res).toEqual({ skillId: 'nyaa' });
  });

  it('leaves an unknown id alone so the host owns the error message', async () => {
    const res = await resolveInstall(stubClient(), 'no-such-skill');

    expect(res).toEqual({ skillId: 'no-such-skill' });
  });

  it('prefers a refreshed catalog so newly published skills are installable', async () => {
    const seen: Array<boolean | undefined> = [];
    const client = stubClient({
      vaizerCatalog: async (refresh?: boolean) => {
        seen.push(refresh);
        return VAIZER_SNAPSHOT;
      },
    });

    await resolveInstall(client, 'nyaa');

    expect(seen).toEqual([true]);
  });

  it('resolves every skill in the bundled snapshot', async () => {
    const catalog: VaizerCatalog = VAIZER_SNAPSHOT;
    expect(catalog.skills.length).toBeGreaterThan(0);

    for (const skill of catalog.skills) {
      const res = await resolveInstall(stubClient(), skill.slug);
      expect(res.payload, `${skill.slug} should resolve to a payload`).toBeDefined();
      expect(res.skillId).toBe(`vaizer-${skill.id}`);
    }
  });
});
