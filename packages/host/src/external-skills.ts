import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';
import type { ExternalSkillTool, SkillDef, SkillWorkflow } from '@agent-nekko/shared';

/**
 * Skills other agent tools already keep on this machine, in the Agent Skills
 * format (agentskills.io): a folder holding a SKILL.md with `name` and
 * `description` frontmatter followed by instructions. Reading them lets a user's
 * existing Claude Code / Codex / Gemini CLI skills run in Agent Nekko with any
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

export interface ParsedSkillFile {
  name?: string;
  description?: string;
  body: string;
}

/**
 * Read the top-level `name` and `description` out of SKILL.md frontmatter.
 * Deliberately small: plain and quoted scalars plus `>` / `|` block scalars.
 * Nested keys (metadata, allowed-tools lists) are ignored.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillFile {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!fm) return { body: text.trim() };

  const fields: Record<string, string> = {};
  const lines = fm[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].trim());
      }
      value = block.join(value.startsWith('>') ? ' ' : '\n').replace(/ {2,}/g, ' ').trim();
    } else if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    fields[kv[1].toLowerCase()] = value;
  }
  return {
    name: fields.name || undefined,
    description: fields.description || undefined,
    body: text.slice(fm[0].length).trim(),
  };
}

export interface DiscoverOptions {
  /** Home directory to scan (defaults to the real one; tests pass a temp dir). */
  home?: string;
  /** Project roots whose own `.claude/skills` etc. are scanned too. They win name collisions. */
  projectRoots?: string[];
  /** Skill folders Agent Nekko wrote itself (marketplace exports), so they are not imported back. */
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
      template: skillTemplate(name, dir, parsed.body),
      category: 'Imported',
      origin: { tool, scope, dir },
      workflow: externalWorkflow(name),
    };
  } catch {
    return undefined;
  }
}

/**
 * What reaches the model when the skill is used. The folder is named because
 * skills often point at files beside SKILL.md (scripts/, references) by
 * relative path.
 */
function skillTemplate(name: string, dir: string, body: string): string {
  return [
    `Follow the "${name}" skill below. Its folder is ${dir}; resolve any relative file paths it mentions against that folder.`,
    '',
    body,
  ].join('\n');
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