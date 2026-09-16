import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { basename, join, resolve } from 'path';
import type { EngineLoadPreset, LocalModel } from '@agent-nekko/shared';
import { readGgufMetadata } from './gguf.js';

/**
 * The models on this machine.
 *
 * The index is a cache, not the truth: the files are the truth. Every read
 * reconciles the two, so a GGUF dropped into the folder by hand appears without
 * an import step and a file deleted outside the app disappears without a stale
 * row. That is deliberate, because a model directory is something people manage
 * with a file manager as much as with an app.
 *
 * Geometry comes from each file's own GGUF header, which is what lets the fit
 * planner give an exact answer for a model we hold rather than the partial one it
 * has to give for LM Studio.
 */

const INDEX_FILE = 'library.json';

interface IndexFile {
  models: Record<string, StoredModel>;
}

type StoredModel = Omit<LocalModel, 'path' | 'sizeBytes'> & { file: string };

export interface LibraryDeps {
  /** Where GGUF files live. */
  modelsDir: () => string;
}

export function createLibrary(deps: LibraryDeps) {
  /** Path of the index, kept beside the models it describes. */
  const indexPath = () => join(deps.modelsDir(), INDEX_FILE);

  async function readIndex(): Promise<IndexFile> {
    try {
      const parsed = JSON.parse(await readFile(indexPath(), 'utf8')) as IndexFile;
      return parsed?.models ? parsed : { models: {} };
    } catch {
      return { models: {} };
    }
  }

  async function writeIndex(index: IndexFile): Promise<void> {
    await mkdir(deps.modelsDir(), { recursive: true });
    await writeFile(indexPath(), JSON.stringify(index, null, 2), 'utf8');
  }

  /** Every `.gguf` under the models dir, one level of nesting included. */
  async function scanFiles(): Promise<string[]> {
    const root = deps.modelsDir();
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(full, depth + 1);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) out.push(full);
      }
    };
    await walk(root, 0);
    return out;
  }

  /**
   * The library, reconciled against disk.
   *
   * A file already indexed is returned from the index (reading a GGUF header is
   * cheap but not free, and this runs on a poll). A file that is new gets read
   * once and written back.
   */
  async function list(): Promise<LocalModel[]> {
    const index = await readIndex();
    const files = await scanFiles();
    const byFile = new Map<string, StoredModel>();
    for (const stored of Object.values(index.models)) byFile.set(stored.file, stored);

    const out: LocalModel[] = [];
    let dirty = false;

    for (const path of files) {
      // A shard past the first is part of another model, not a model.
      if (/-\d{5}-of-\d{5}\.gguf$/i.test(path) && !/-00001-of-\d{5}\.gguf$/i.test(path)) continue;
      if (/mmproj/i.test(basename(path))) continue;

      const size = await stat(path).then((s) => s.size).catch(() => 0);
      if (size === 0) continue;

      let stored = byFile.get(path);
      if (!stored) {
        stored = await describe(path);
        index.models[stored.id] = stored;
        dirty = true;
      }
      out.push({ ...stored, path, sizeBytes: size });
    }

    // Drop rows whose file is gone, so a model deleted in Explorer stops showing.
    const alive = new Set(out.map((m) => m.id));
    for (const id of Object.keys(index.models)) {
      if (!alive.has(id)) {
        delete index.models[id];
        dirty = true;
      }
    }
    if (dirty) await writeIndex(index);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Read one file's header into a library row. */
  async function describe(path: string): Promise<StoredModel> {
    const meta = await readGgufMetadata(path);
    const file = basename(path);
    return {
      id: idFor(path),
      name: meta?.name?.trim() || file.replace(/\.gguf$/i, ''),
      file: path,
      quantization: meta?.quantization,
      parameterSize: meta?.parameterSize,
      architecture: meta?.architecture,
      layers: meta?.layers,
      kvHeads: meta?.kvHeads,
      headDim: meta?.headDim,
      maxContext: meta?.maxContext,
      addedAt: Date.now(),
    };
  }

  /**
   * A stable id: the path below the models dir, slashes normalized.
   *
   * It doubles as the model id served over the API, so it has to be stable across
   * restarts and safe in a URL, and it has to survive the models dir moving.
   */
  function idFor(path: string): string {
    const root = resolve(deps.modelsDir());
    const full = resolve(path);
    const rel = full.startsWith(root) ? full.slice(root.length + 1) : basename(full);
    return rel.replace(/\\/g, '/').replace(/\.gguf$/i, '');
  }

  async function find(id: string): Promise<LocalModel | undefined> {
    return (await list()).find((m) => m.id === id);
  }

  /** Adopt a GGUF that lives somewhere else, without copying it. */
  async function importFile(path: string): Promise<{ ok: boolean; message: string; model?: LocalModel }> {
    const size = await stat(path).then((s) => s.size).catch(() => 0);
    if (!size) return { ok: false, message: 'That file does not exist.' };
    if (!path.toLowerCase().endsWith('.gguf')) {
      return { ok: false, message: 'Agent Nekko runs GGUF files. Convert or download a GGUF build of this model.' };
    }
    const meta = await readGgufMetadata(path);
    if (!meta) return { ok: false, message: "That file isn't a readable GGUF." };

    const index = await readIndex();
    const stored = await describe(path);
    index.models[stored.id] = stored;
    await writeIndex(index);
    return { ok: true, message: `Added ${stored.name}.`, model: { ...stored, path, sizeBytes: size } };
  }

  /** Delete the file and its row. Shards and projectors go with it. */
  async function remove(id: string): Promise<{ ok: boolean; message: string }> {
    const model = await find(id);
    if (!model) return { ok: false, message: 'That model is not in the library.' };

    const companions = (await scanFiles()).filter((p) => isCompanionOf(p, model.path));
    for (const path of [model.path, ...companions]) await rm(path, { force: true });

    const index = await readIndex();
    delete index.models[id];
    await writeIndex(index);
    return { ok: true, message: `Deleted ${model.name}.` };
  }

  /** Save per-model load settings, so a model loads the same way every time. */
  async function savePreset(id: string, preset: EngineLoadPreset): Promise<void> {
    const index = await readIndex();
    const stored = index.models[id];
    if (!stored) return;
    stored.preset = preset;
    await writeIndex(index);
  }

  /** Total bytes the library occupies, for the disk-use line. */
  async function diskUsage(): Promise<number> {
    return (await list()).reduce((n, m) => n + m.sizeBytes, 0);
  }

  return { list, find, importFile, remove, savePreset, diskUsage, idFor };
}

export type Library = ReturnType<typeof createLibrary>;

/** A later shard or the projector belonging to the same model. */
function isCompanionOf(candidate: string, primary: string): boolean {
  if (candidate === primary) return false;
  const stem = primary.replace(/-00001-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '');
  return candidate.startsWith(stem) && /(-\d{5}-of-\d{5}\.gguf|mmproj.*\.gguf)$/i.test(candidate);
}
