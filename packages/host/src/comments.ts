import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { LineComment } from '@agent-nekko/shared';
import { dataDir } from './store.js';

/**
 * Inline editor comments: gutter annotations the user leaves on a line for the
 * agent to pick up ("Add to prompt" / "Run now"). Persisted to a single JSON
 * file keyed by absolute file path so they survive pane reopen and restart, and
 * show as gutter markers until resolved. The two agent actions are renderer-side
 * (they route the comment to a chat), this store is just durable annotation.
 */

type Store = Record<string, LineComment[]>;

function file(): string {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'comments.json');
}

function load(): Store {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Store;
  } catch {
    return {};
  }
}

function save(store: Store): void {
  writeFileSync(file(), JSON.stringify(store, null, 2), 'utf8');
}

export function listComments(path: string): LineComment[] {
  return (load()[path] ?? []).sort((a, b) => a.line - b.line || a.createdAt - b.createdAt);
}

export function addComment(path: string, line: number, lineText: string, comment: string): LineComment[] {
  const store = load();
  const entry: LineComment = { id: randomUUID(), path, line, lineText, comment, createdAt: Date.now() };
  store[path] = [...(store[path] ?? []), entry];
  save(store);
  return listComments(path);
}

export function resolveComment(path: string, id: string): LineComment[] {
  const store = load();
  store[path] = (store[path] ?? []).filter((c) => c.id !== id);
  if (store[path].length === 0) delete store[path];
  save(store);
  return listComments(path);
}
