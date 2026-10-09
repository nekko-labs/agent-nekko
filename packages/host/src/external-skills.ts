import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import type { ExternalSkillTool, SkillDef, SkillWorkflow } from '@nekko-agent/shared';
import { parseSkillMarkdown } from '@nekko-agent/shared';

/**
 * Skills other agent tools already keep on this machine, in the Agent Skills
 * format (agentskills.io): a folder holding a SKILL.md with `name` and
 * `description` frontmatter followed by instructions. Reading them lets a user's
 * existing Claude Code / Codex / Gemini CLI skills run in Nekko Agent with any
 * model. Nothing here writes to those folders.
 */

/** Where each tool keeps its skills, relative to the home dir or a project root. */
const TOOL_DIRS: ReadonlyArray<readonly [ExternalSkillTool, string]> = [
  ['claude', join('.claude', 'skills')],
  ['codex', join('.codex', 'skills')],
  ['gemini', join('.gemini', 'skills')],
  ['agents', join('.agents', 'skills')],
];

/** A SKILL.md larger than this is skipped rather than pasted into a prompt. */
export const MAX_SKILL_BYTES = 256 * 1024;

const NAME_RE = /^[a-z0-9._-]+$/i;

export interface DiscoverOptions {
  /** Home directory to scan (defaults to the real one; tests pass a temp dir). */
  home?: string;
  /** Project roots whose own `.claude/skills` etc. are scanned too. They win name collisions. */
  projectRoots?: string[];
  /** Skill folders Nekko Agent wrote itself (marketplace exports), so they are not imported back. */
  exclude?: Iterable<string>;
  /** Names already taken (built-in and installed skills win collisions). */
  reserved?: Iterable<string>;
}

/** Every external skill found, project-level first, each name at most once. */
export function discoverExternalSkills(opts: DiscoverOptions = {}): SkillDef[] {
  const home = opts.home ?? homedir();
  const exclude = new Set([...(opts.exclude ?? [])].map((p) => resolve(p)));
  const taken = new Set([...(opts.reserved ?? [])].map((n) => n.toLowerCase()));
  const seenBases = new Set<string>();
  const out: SkillDef[] = [];

  const bases = [
    ...(opts.projectRoots ?? []).flatMap((root) =>
      TOOL_DIRS.map(([tool, rel]) => ({ tool, scope: 'project' as const, base: join(root, rel) })),
    ),
    ...TOOL_DIRS.map(([tool, rel]) => ({ tool, scope: 'user' as const, base: join(home, rel) })),
  ];

  for (const { tool, scope, base } of bases) {
    const key = resolve(base);
    if (seenBases.has(key)) continue; // a project opened at the home dir
    seenBases.add(key);
    for (const dir of skillDirs(base)) {
      if (exclude.has(resolve(dir))) continue;
      const skill = readSkill(dir, tool, scope);
      if (!skill || taken.has(skill.name.toLowerCase())) continue;
      taken.add(skill.name.toLowerCase());
      out.push(skill);
    }
  }
  return out;
}

function skillDirs(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(base, e.name))
      .filter((d) => existsSync(join(d, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

function readSkill(dir: string, tool: ExternalSkillTool, scope: 'user' | 'project'): SkillDef | undefined {
  const file = join(dir, 'SKILL.md');
  try {
    if (statSync(file).size > MAX_SKILL_BYTES) return undefined;
    const parsed = parseSkillMarkdown(readFileSync(file, 'utf8'));
    const name = parsed.name ?? basename(dir);
    if (!NAME_RE.test(name) || !parsed.body) return undefined;
    return {
      id: `external:${tool}:${scope}:${name}`,
      name,
      description: parsed.description ?? firstLine(parsed.body),
      template: skillTemplate(name, hasOwnFiles(dir) ? dir : undefined, parsed.body),
      category: 'Imported',
      origin: { tool, scope, dir },
      workflow: externalWorkflow(name),
    };
  } catch {
    return undefined;
  }
}

/** True when the skill folder holds anything besides SKILL.md (dotfiles ignored). */
export function hasOwnFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => n !== 'SKILL.md' && !n.startsWith('.'));
  } catch {
    return false;
  }
}

/**
 * What reaches the model when the skill is used. The folder is named only when
 * the skill ships files beside SKILL.md (scripts/, references) that its
 * instructions may point at by relative path. Without such files the path is
 * left out: small models otherwise mistake the skill folder for the project.
 */
function skillTemplate(name: string, dir: string | undefined, body: string): string {
  const intro = dir
    ? `Use the "${name}" skill below. Its own files (scripts, references) are in ${dir}. That folder belongs to the skill, not to the user's project: do the work in the project as usual, and only read from that folder when the instructions point at one of its files.`
    : `Use the "${name}" skill below.`;
  return [intro, '', body].join('\n');
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? '';
  return line.trim().slice(0, 160);
}

function externalWorkflow(name: string): SkillWorkflow {
  return {
    nodes: [
      { id: 't', kind: 'trigger', label: `/${name}`, detail: 'Skill invoked' },
      { id: 'agent', kind: 'agent', label: 'Follow SKILL.md', detail: 'Instructions from the skill file' },
      { id: 'out', kind: 'output', label: 'Deliverable' },
    ],
    edges: [
      { from: 't', to: 'agent' },
      { from: 'agent', to: 'out' },
    ],
  };
}