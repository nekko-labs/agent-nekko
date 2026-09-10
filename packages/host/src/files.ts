import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { DirEntry, FileContent } from '@agent-nekko/shared';

/**
 * Direct, user-initiated file access for the in-app file explorer, viewer, and
 * editor. Unlike the agent's tools these are driven by explicit user clicks, so
 * they aren't sandbox-jailed, the user browses and edits their own projects.
 */

/** Editor read cap (1 MB), large files load partially. */
const MAX_READ = 1_000_000;

/** Read a file as text; flags binary (NUL byte present) and truncation. */
export function readFile(path: string): FileContent {
  if (!existsSync(path) || statSync(path).isDirectory()) {
    return { content: '', truncated: false, binary: false };
  }
  const buf = readFileSync(path);
  const slice = buf.subarray(0, Math.min(buf.length, MAX_READ));
  if (slice.includes(0)) return { content: '', truncated: false, binary: true };
  return { content: slice.toString('utf8'), truncated: buf.length > MAX_READ, binary: false };
}

/** Write text to a file, creating parent directories as needed. */
export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** List a directory's entries, directories first then files (alphabetical). */
export function listDir(path: string): DirEntry[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .map((e) => ({ name: e.name, path: join(path, e.name), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
}
