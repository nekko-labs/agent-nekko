import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { MemoryEntry, MemoryScope } from '@agent-nekko/shared';
import { serializeMemory, parseMemory } from '@agent-nekko/core';
import { dataDir } from './store.js';

function memDir(): string {
  const dir = join(dataDir(), 'memory');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function listMemory(scope: MemoryScope, workspaceId?: string): MemoryEntry[] {
  return readdirSync(memDir())
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      try {
        return parseMemory(readFileSync(join(memDir(), f), 'utf8'), f.replace(/\.md$/, ''));
      } catch {
        return null;
      }
    })
    .filter((m): m is MemoryEntry => !!m)
    .filter((m) => m.scope === scope && (scope === 'global' || m.workspaceId === workspaceId))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveMemory(entry: MemoryEntry): void {
  entry.updatedAt = Date.now();
  writeFileSync(join(memDir(), `${entry.id}.md`), serializeMemory(entry), 'utf8');
}

export function deleteMemory(id: string): void {
  const p = join(memDir(), `${id}.md`);
  if (existsSync(p)) rmSync(p);
}

/** Delete every memory note (global + per-workspace). */
export function clearMemory(): void {
  for (const f of readdirSync(memDir())) {
    if (f.endsWith('.md')) rmSync(join(memDir(), f));
  }
}
