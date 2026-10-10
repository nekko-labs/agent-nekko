import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join, extname } from 'path';
import type { DirEntry, FileContent } from '@nekko-agent/shared';

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
  const size = statSync(path).size;
  const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extname(path).toLowerCase()];
  if (mime && size > 8_000_000) return { content: '', truncated: true, binary: true };
  const buf = readFileSync(path);
  const signature = mime === 'image/png' ? buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : mime === 'image/jpeg' ? buf[0] === 255 && buf[1] === 216 && buf[2] === 255
    : mime === 'image/gif' ? /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))
    : mime === 'image/webp' ? buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' : false;
  if (mime && signature) return { content: '', binary: true, truncated: false, imageDataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
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
