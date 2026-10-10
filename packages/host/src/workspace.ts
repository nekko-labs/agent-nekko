import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import type { IndexedFile, IndexStatus, SearchHit, WorkspaceFolder } from '@agent-nekko/shared';
import { IGNORED_DIRS, isIndexable, detectLanguage, extractOutline } from '@agent-nekko/core';

const indexCache = new Map<string, IndexedFile[]>();
const statusCache = new Map<string, IndexStatus>();

export function getIndexStatus(id: string): IndexStatus | null {
  return statusCache.get(id) ?? null;
}

export function listIndexedFiles(id: string): IndexedFile[] {
  return indexCache.get(id) ?? [];
}

/** Walk a workspace folder, build the file + symbol index. Synchronous but bounded. */
export function indexWorkspace(folder: WorkspaceFolder, onProgress?: (s: IndexStatus) => void): IndexStatus {
  const files: IndexedFile[] = [];
  let symbolCount = 0;
  const MAX_FILES = 5000;

  const status: IndexStatus = {
    workspaceId: folder.id,
    fileCount: 0,
    symbolCount: 0,
    progress: 0,
    state: 'indexing',
    updatedAt: Date.now(),
  };
  statusCache.set(folder.id, status);
  onProgress?.(status);

  const walk = (dir: string) => {
    if (files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.env') {
        if (IGNORED_DIRS.has(e.name)) continue;
      }
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
      } else if (isIndexable(e.name)) {
        const full = join(dir, e.name);
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        if (size > 1_000_000) continue;
        const language = detectLanguage(full);
        let symbols: ReturnType<typeof extractOutline> = [];
        if (language) {
          try {
            symbols = extractOutline(readFileSync(full, 'utf8'), language);
          } catch {
            /* skip */
          }
        }
        symbolCount += symbols.length;
        files.push({
          path: full,
          relPath: relative(folder.path, full).replace(/\\/g, '/'),
          sizeBytes: size,
          language,
          symbols,
        });
      }
    }
  };

  try {
    walk(folder.path);
    indexCache.set(folder.id, files);
    const done: IndexStatus = {
      workspaceId: folder.id,
      fileCount: files.length,
      symbolCount,
      progress: 1,
      state: 'ready',
      updatedAt: Date.now(),
    };
    statusCache.set(folder.id, done);
    onProgress?.(done);
    return done;
  } catch {
    const errStatus: IndexStatus = { ...status, state: 'error', updatedAt: Date.now() };
    statusCache.set(folder.id, errStatus);
    return errStatus;
  }
}

/** Search indexed files' contents for a query (case-insensitive substring). */
export function searchWorkspace(folder: WorkspaceFolder, query: string): SearchHit[] {
  const files = indexCache.get(folder.id) ?? [];
  const hits: SearchHit[] = [];
  const q = query.toLowerCase();
  for (const f of files) {
    if (hits.length >= 100) break;
    let content: string;
    try {
      content = readFileSync(f.path, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && hits.length < 100; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        hits.push({ path: f.path, relPath: f.relPath, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return hits;
}
