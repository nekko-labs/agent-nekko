/**
 * SKILL.md parsing (Agent Skills format, agentskills.io): `name` and
 * `description` frontmatter followed by instructions. Shared by imported skills
 * (host) and marketplace skills that carry a verbatim SKILL.md (Vaizer).
 */

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
