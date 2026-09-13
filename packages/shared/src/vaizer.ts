/**
 * Vaizer skills integration: an optional connection to the public Agent Skills
 * marketplace at github.com/nekko-labs/vaizer (browsable at vaizer.app/skills).
 * Vaizer is a separate app; Agent Nekko only reads its machine-readable catalog and
 * installs skills the user explicitly picks.
 *
 * Offline-first: the marketplace shelf renders from the bundled snapshot
 * below with zero network. The catalog is only fetched from GitHub when the
 * user clicks "Refresh" (and a skill's SKILL.md is fetched at install time so
 * the real, current instructions are installed).
 *
 * (Until 2026-08-02 these skills lived in a separate repo,
 * `nekko-labs/nekko-dojo-skills`, and the shelf was labelled "Kotrain Dojo".)
 */

import type { MarketplaceSkill } from './skills-market.js';
import type { SkillCategory } from './skills.js';

/** Trust tiers from the Vaizer repo. Official = built + reviewed by Nekko Labs. */
export type VaizerTier = 'kotrain-official' | 'community';

/** One entry of the Vaizer repo's catalog.json. */
export interface VaizerCatalogSkill {
  id: string;
  name: string;
  slug: string;
  tier: VaizerTier;
  /** Vaizer's free-form category (research, engineering, career, ...). */
  category: string;
  description: string;
  tags?: string[];
  author: string;
  version?: string;
  license?: string;
  installCommand?: string;
  sourceUrl?: string;
}

export interface VaizerCatalog {
  marketplace: string;
  addCommand?: string;
  skills: VaizerCatalogSkill[];
  /** Where this catalog came from. */
  source: 'live' | 'cached' | 'bundled';
  /** Epoch ms of the last successful live fetch (absent for bundled). */
  fetchedAt?: number;
}

export const VAIZER_REPO = 'nekko-labs/vaizer';
export const VAIZER_REPO_URL = `https://github.com/${VAIZER_REPO}`;
export const VAIZER_SITE_URL = 'https://vaizer.app/skills';
export const VAIZER_CATALOG_URL = `https://raw.githubusercontent.com/${VAIZER_REPO}/main/catalog.json`;

/** Raw URL of a Vaizer skill's SKILL.md (agentskills.io plugin layout). */
export function vaizerSkillMdUrl(slug: string): string {
  // Every Vaizer skill lives in one `vaizer` plugin, so that Claude Code
  // invokes them as `/vaizer:<skill>` rather than `/<skill>:<skill>`. Before
  // 2026-08-28 each skill was its own plugin at `plugins/<slug>/skills/<slug>`.
  return `https://raw.githubusercontent.com/${VAIZER_REPO}/main/plugins/vaizer/skills/${slug}/SKILL.md`;
}

/**
 * The pre-2026-08-28 layout, when each skill was its own plugin. Released
 * Kotrain versions still ask for this path, and a checkout of the marketplace
 * from before the restructure still serves it, so the fetch tries it as a
 * fallback rather than silently degrading to the catalog summary.
 */
export function vaizerLegacySkillMdUrl(slug: string): string {
  return `https://raw.githubusercontent.com/${VAIZER_REPO}/main/plugins/${slug}/skills/${slug}/SKILL.md`;
}


/**
 * Bundled snapshot of the Vaizer catalog so the shelf works fully offline.
 * Kept in sync with the repo's catalog.json when the integration is touched.
 */
export const VAIZER_SNAPSHOT: VaizerCatalog = {
  marketplace: 'vaizer',
  addCommand: '/plugin marketplace add nekko-labs/vaizer',
  source: 'bundled',
  skills: [
    {
      id: 'domain-finder',
      name: 'Domain Finder',
      slug: 'domain-finder',
      tier: 'kotrain-official',
      category: 'research',
      description:
        'Brainstorm startup/project names, check domain availability across TLDs via RDAP, and vet brand/trademark conflicts.',
      tags: ['domains', 'naming', 'branding', 'rdap', 'startup', 'trademark'],
      author: 'Nekko Labs',
      version: '1.0.0',
      license: 'MIT',
      installCommand: '/plugin install domain-finder@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/domain-finder`,
    },
    {
      id: 'nyaa',
      name: 'nyaa',
      slug: 'nyaa',
      tier: 'kotrain-official',
      category: 'engineering',
      description:
        'Convene a council of four reviewer cats (security, deps/supply-chain, correctness/concurrency, style) over a PR or working diff, pulling in external bot reviews too.',
      tags: ['code-review', 'pull-request', 'security', 'dependencies', 'supply-chain', 'concurrency', 'lint'],
      author: 'Nekko Labs',
      version: '1.0.0',
      license: 'MIT',
      installCommand: '/plugin install nyaa@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/nyaa`,
    },
    {
      id: 'resume-checker',
      name: 'Resume Checker',
      slug: 'resume-checker',
      tier: 'kotrain-official',
      category: 'career',
      description:
        'Check a resume against automated candidate-screening (ATS) signals and AI-centric job expectations, score it against specific job postings, then interactively apply fixes and show exactly what changed.',
      tags: ['resume', 'cv', 'ats', 'job-hunt', 'career', 'screening', 'ai-roles'],
      author: 'Nekko Labs',
      version: '1.0.0',
      license: 'MIT',
      installCommand: '/plugin install resume-checker@vaizer',
      sourceUrl: `${VAIZER_REPO_URL}/tree/main/plugins/vaizer/skills/resume-checker`,
    },
  ],
};

/** Map Vaizer's free-form category onto Agent Nekko's skill categories. */
export function vaizerCategory(cat: string): SkillCategory {
  const c = cat.toLowerCase();
  if (/research|planning|naming|brainstorm|career|resume|job/.test(c)) return 'Research & planning';
  if (/engineering|review|quality|security|test|lint/.test(c)) return 'Code quality';
  if (/delivery|release|ship|deploy|docs/.test(c)) return 'Delivery';
  return 'Automation';
}

/** Strip YAML frontmatter from a SKILL.md, returning { frontmatter, body }. */
export function splitSkillMd(md: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { frontmatter: '', body: md.trim() };
  return { frontmatter: m[1], body: md.slice(m[0].length).trim() };
}

/**
 * A Vaizer catalog entry as a marketplace skill. When the full SKILL.md is
 * available (fetched at install time) it rides along verbatim as `markdown`
 * so file-based installs get the real skill, not a summary.
 */
export function vaizerToMarketSkill(d: VaizerCatalogSkill, skillMd?: string): MarketplaceSkill {
  const body = skillMd ? splitSkillMd(skillMd).body : undefined;
  const id = `vaizer-${d.id}`;
  return {
    id,
    // Installed skills are invoked as /<name>; use the slug (already kebab-case).
    name: d.slug,
    description: d.description,
    author: d.author,
    source: 'vaizer',
    tier: d.tier,
    category: vaizerCategory(d.category),
    url: d.sourceUrl ?? VAIZER_REPO_URL,
    template: `Use the ${d.name} skill. ${d.description}\n\n`,
    instructions: body ?? d.description,
    markdown: skillMd,
  };
}
