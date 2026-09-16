import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';

/**
 * Reading Ollama's model folder.
 *
 * Ollama does not keep files named after models. It keeps content-addressed
 * blobs (`blobs/sha256-…`, no extension) and a tree of manifests that say which
 * blob is the weights for `llama3.2:latest`. A plain directory walk therefore
 * finds either nothing (we only match `.gguf`) or a pile of hashes, and neither
 * is a model list anyone can use.
 *
 * So this reads the manifests instead. It is the one folder layout that needs
 * its own reader, and it is worth one because Ollama is the most common way a
 * machine already has models on it.
 */

/** The layer that holds the weights. Everything else is a template or params. */
const MODEL_LAYER = 'application/vnd.ollama.image.model';

export interface OllamaModel {
  /** `llama3.2:latest`, or `hf.co/user/repo:Q4_K_M` for a pulled repo. */
  name: string;
  /** Absolute path of the blob holding the weights. */
  path: string;
  sizeBytes: number;
}

interface Manifest {
  layers?: Array<{ mediaType?: string; digest?: string; size?: number }>;
}

/**
 * Every model Ollama has pulled into this folder.
 *
 * Returns an empty list for a folder that is not an Ollama store, which is what
 * makes it safe to call on any configured folder rather than only on the one we
 * detected.
 */
export async function listOllamaModels(root: string): Promise<OllamaModel[]> {
  const manifestRoot = join(root, 'manifests');
  const blobRoot = join(root, 'blobs');
  if (!(await isDir(manifestRoot)) || !(await isDir(blobRoot))) return [];

  const out: OllamaModel[] = [];
  for (const file of await walk(manifestRoot, 0)) {
    const manifest = await readJson<Manifest>(file);
    const digest = manifest?.layers?.find((l) => l.mediaType === MODEL_LAYER)?.digest;
    if (!digest) continue;

    const path = join(blobRoot, digest.replace(':', '-'));
    const size = await stat(path)
      .then((s) => s.size)
      .catch(() => 0);
    if (!size) continue;

    out.push({ name: modelName(manifestRoot, file), path, sizeBytes: size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The manifest path back into the name you would type at `ollama run`.
 *
 * `manifests/registry.ollama.ai/library/llama3.2/latest` is `llama3.2:latest`:
 * the default registry and the `library` namespace are dropped because Ollama
 * itself drops them, and a model called `registry.ollama.ai/library/llama3.2`
 * in our list would match nothing anyone recognises.
 */
export function modelName(manifestRoot: string, file: string): string {
  const rel = file.slice(manifestRoot.length + 1).replace(/\\/g, '/');
  const parts = rel.split('/').filter(Boolean);
  const tag = parts.pop() ?? 'latest';
  if (parts[0] === 'registry.ollama.ai' || parts[0] === 'ollama.com') parts.shift();
  if (parts[0] === 'library') parts.shift();
  return `${parts.join('/')}:${tag}`;
}

async function walk(dir: string, depth: number): Promise<string[]> {
  // Four levels covers `<registry>/<namespace>/<model>/<tag>`, which is as deep
  // as Ollama's tree goes.
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, depth + 1)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}
