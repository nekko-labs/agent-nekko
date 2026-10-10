import type { MemoryEntry, MemoryScope } from '@agent-nekko/shared';

/**
 * Serialize a memory entry to a markdown document with YAML-ish frontmatter.
 * The host persists these as individual .md files so memory is human-readable
 * and git-friendly.
 */
export function serializeMemory(entry: MemoryEntry): string {
  return [
    '---',
    `id: ${entry.id}`,
    `scope: ${entry.scope}`,
    entry.workspaceId ? `workspaceId: ${entry.workspaceId}` : null,
    `title: ${escapeYaml(entry.title)}`,
    `tags: [${entry.tags.join(', ')}]`,
    `createdAt: ${entry.createdAt}`,
    `updatedAt: ${entry.updatedAt}`,
    '---',
    '',
    entry.body,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export function parseMemory(markdown: string, fallbackId: string): MemoryEntry {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  const meta: Record<string, string> = {};
  let body = markdown;
  if (m) {
    body = m[2].trim();
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return {
    id: meta.id || fallbackId,
    scope: (meta.scope as MemoryScope) || 'global',
    workspaceId: meta.workspaceId || undefined,
    title: unescapeYaml(meta.title || 'Untitled'),
    body,
    tags: parseTags(meta.tags),
    createdAt: Number(meta.createdAt) || Date.now(),
    updatedAt: Number(meta.updatedAt) || Date.now(),
  };
}

function parseTags(s?: string): string[] {
  if (!s) return [];
  return s.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean);
}

function escapeYaml(s: string): string {
  return /[:#]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
function unescapeYaml(s: string): string {
  return s.replace(/^"|"$/g, '').replace(/\\"/g, '"');
}
