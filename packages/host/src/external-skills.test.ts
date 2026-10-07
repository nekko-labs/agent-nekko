import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverExternalSkills, MAX_SKILL_BYTES, parseSkillMarkdown } from './external-skills';

let root: string;
let home: string;
let project: string;

function skill(base: string, folder: string, content: string): string {
  const dir = join(base, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
  return dir;
}

const md = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nekko-ext-skills-'));
  home = join(root, 'home');
  project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('parseSkillMarkdown', () => {
  it('reads plain, quoted and folded frontmatter values', () => {
    const parsed = parseSkillMarkdown(
      '---\nname: "pdf"\ndescription: >\n  Work with PDFs.\n  Use for forms.\nlicense: MIT\nmetadata:\n  name: nested\n---\n# PDF\nBody',
    );
    expect(parsed.name).toBe('pdf');
    expect(parsed.description).toBe('Work with PDFs. Use for forms.');
    expect(parsed.body).toBe('# PDF\nBody');
  });

  it('treats a file without frontmatter as body only', () => {
    expect(parseSkillMarkdown('Just instructions')).toEqual({ body: 'Just instructions' });
  });
});

describe('discoverExternalSkills', () => {
  it('finds skills from every tool folder and records where they came from', () => {
    skill(join(home, '.claude', 'skills'), 'review-pr', md('review-pr', 'Review a PR'));
    skill(join(home, '.codex', 'skills'), 'deploy', md('deploy', 'Deploy the app'));
    const found = discoverExternalSkills({ home });
    expect(found.map((s) => s.name)).toEqual(['review-pr', 'deploy']);
    expect(found[0].origin).toMatchObject({ tool: 'claude', scope: 'user' });
    expect(found[0].category).toBe('Imported');
    expect(found[0].template).toContain('Do the thing.');
    expect(found[0].template).toContain(join(home, '.claude', 'skills', 'review-pr'));
  });

  it('lets a project skill win over a user skill with the same name', () => {
    skill(join(home, '.claude', 'skills'), 'lint', md('lint', 'user version'));
    skill(join(project, '.claude', 'skills'), 'lint', md('lint', 'project version'));
    const found = discoverExternalSkills({ home, projectRoots: [project] });
    expect(found).toHaveLength(1);
    expect(found[0].description).toBe('project version');
    expect(found[0].origin?.scope).toBe('project');
  });

  it('skips reserved names, excluded folders, invalid names and oversized files', () => {
    const base = join(home, '.claude', 'skills');
    skill(base, 'review', md('review', 'clashes with a built-in'));
    const exported = skill(base, 'changelog', md('changelog', 'written by Nekko itself'));
    skill(base, 'bad', md('bad name!', 'invalid'));
    skill(base, 'huge', md('huge', 'too big', 'x'.repeat(MAX_SKILL_BYTES + 1)));
    skill(base, 'ok', md('ok', 'fine'));
    mkdirSync(join(base, 'no-skill-file'));
    const found = discoverExternalSkills({ home, reserved: ['review'], exclude: [exported] });
    expect(found.map((s) => s.name)).toEqual(['ok']);
  });

  it('falls back to the folder name and first line when frontmatter is missing', () => {
    skill(join(home, '.agents', 'skills'), 'notes', '# Notes\nKeep tidy meeting notes.');
    const [found] = discoverExternalSkills({ home });
    expect(found.name).toBe('notes');
    expect(found.description).toBe('Keep tidy meeting notes.');
  });

  it('returns nothing when no skill folders exist', () => {
    expect(discoverExternalSkills({ home, projectRoots: [project] })).toEqual([]);
  });
});