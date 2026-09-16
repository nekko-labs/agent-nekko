import type { CatalogModel, CatalogQuant } from '@agent-nekko/shared';

/**
 * Where models come from.
 *
 * Two sources, deliberately. A **curated** list answers the question a new user
 * actually has, which is not "search Hugging Face" but "what should I run on
 * this machine"; it is small, opinionated, and every entry is a GGUF repo that
 * exists. **Search** is the escape hatch for everyone else, straight against the
 * Hugging Face API with no key, because pinning people to our list would make
 * this worse than the thing it replaces.
 *
 * Sizes come from the repo's file tree rather than from the model card, so the
 * figure in the picker is the number of bytes that will actually be transferred.
 */

const HF_API = 'https://huggingface.co/api';

/** Quant names ordered worst-to-best, for sorting a repo's files sensibly. */
const QUANT_ORDER = [
  'IQ1', 'IQ2', 'Q2_K', 'IQ3', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'IQ4', 'Q4_K_S', 'Q4_K_M',
  'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'MXFP4', 'BF16', 'F16', 'F32',
];

/** What each quant is for, in the one line a picker has room for. */
const QUANT_NOTES: Record<string, string> = {
  Q3_K_M: 'Smallest useful size. Noticeably rougher.',
  Q4_K_M: 'The usual choice: best balance of size and quality.',
  Q5_K_M: 'A little larger, a little better.',
  Q6_K: 'Close to full quality, much bigger.',
  Q8_0: 'Effectively full quality. Large.',
  F16: 'Unquantized. Very large.',
};

/**
 * The starter list.
 *
 * Kept short on purpose: this is the "what do I run" answer, not a directory.
 * Every entry is a repo of GGUF files, and the quants are discovered from the
 * repo rather than hardcoded, so a repo adding a build shows up without an edit
 * here.
 */
const CURATED: Array<Omit<CatalogModel, 'quants'>> = [
  {
    id: 'bartowski/Qwen2.5-7B-Instruct-GGUF',
    name: 'Qwen2.5 7B Instruct',
    owner: 'Qwen',
    parameterSize: '7B',
    summary: 'A strong all-rounder that fits comfortably on most machines.',
    tags: ['chat', 'tools'],
    curated: true,
  },
  {
    id: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    name: 'Qwen2.5 Coder 7B',
    owner: 'Qwen',
    parameterSize: '7B',
    summary: 'Tuned for code: reading, writing, and editing it.',
    tags: ['code', 'tools'],
    curated: true,
  },
  {
    id: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF',
    name: 'Llama 3.1 8B Instruct',
    owner: 'Meta',
    parameterSize: '8B',
    summary: 'A widely supported general model with a long context.',
    tags: ['chat', 'tools'],
    curated: true,
  },
  {
    id: 'bartowski/google_gemma-3-12b-it-GGUF',
    name: 'Gemma 3 12B',
    owner: 'Google',
    parameterSize: '12B',
    summary: 'Larger and more capable, and it can read images.',
    tags: ['chat', 'vision'],
    curated: true,
  },
  {
    id: 'unsloth/Qwen3-4B-GGUF',
    name: 'Qwen3 4B',
    owner: 'Qwen',
    parameterSize: '4B',
    summary: 'Small and fast, with optional step-by-step reasoning.',
    tags: ['chat', 'reasoning'],
    curated: true,
  },
  {
    id: 'ggml-org/gpt-oss-20b-GGUF',
    name: 'gpt-oss 20B',
    owner: 'OpenAI',
    parameterSize: '20B',
    summary: 'An open-weight reasoning model. Needs a roomy GPU.',
    tags: ['chat', 'reasoning', 'tools'],
    curated: true,
  },
  {
    id: 'CompendiumLabs/bge-small-en-v1.5-gguf',
    name: 'BGE Small (embeddings)',
    owner: 'BAAI',
    parameterSize: '33M',
    summary: 'Turns text into vectors for search. Tiny.',
    tags: ['embedding'],
    curated: true,
  },
];

export interface CatalogDeps {
  fetch?: typeof fetch;
  /** Optional HF token, for gated repos the user has access to. */
  token?: () => string | undefined;
}

export function createCatalog(deps: CatalogDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const cache = new Map<string, { at: number; value: CatalogModel | null }>();
  const CACHE_TTL_MS = 10 * 60_000;

  function headers(): Record<string, string> {
    const token = deps.token?.();
    return {
      accept: 'application/json',
      'user-agent': 'agent-nekko',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /** The starter list, with each repo's real files and sizes filled in. */
  async function curated(): Promise<CatalogModel[]> {
    const filled = await Promise.all(
      CURATED.map(async (entry) => {
        const quants = await quantsFor(entry.id);
        return { ...entry, quants };
      }),
    );
    // A repo that has been renamed or pulled should drop off the list rather than
    // render as an entry with nothing to download.
    return filled.filter((m) => m.quants.length > 0);
  }

  /** Free-text search over Hugging Face's GGUF repos. */
  async function search(query: string, limit = 20): Promise<CatalogModel[]> {
    const q = query.trim();
    if (!q) return curated();
    const url = `${HF_API}/models?filter=gguf&search=${encodeURIComponent(q)}&sort=downloads&direction=-1&limit=${limit}`;
    const rows = await getJson<
      Array<{ id?: string; modelId?: string; downloads?: number; gated?: boolean | string; tags?: string[] }>
    >(url);
    if (!rows) return [];

    // Sizes need one tree request per repo, so they are fetched for the page of
    // results being shown rather than for everything the search matched.
    return (
      await Promise.all(
        rows.slice(0, limit).map(async (row): Promise<CatalogModel | null> => {
          const id = row.id ?? row.modelId;
          if (!id) return null;
          const quants = await quantsFor(id);
          if (quants.length === 0) return null;
          const [owner, repo] = id.split('/');
          return {
            id,
            name: prettyName(repo ?? id),
            owner: owner ?? 'unknown',
            parameterSize: paramHint(repo ?? ''),
            tags: capabilityTags(row.tags ?? [], repo ?? ''),
            quants,
            downloads: row.downloads,
            gated: Boolean(row.gated),
          } satisfies CatalogModel;
        }),
      )
    ).filter((m): m is CatalogModel => m !== null);
  }

  /** One repo's detail, including every GGUF it publishes. */
  async function model(id: string): Promise<CatalogModel | null> {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const info = await getJson<{ id?: string; downloads?: number; gated?: boolean | string; cardData?: { license?: string }; tags?: string[] }>(
      `${HF_API}/models/${id}`,
    );
    const quants = await quantsFor(id);
    const [owner, repo] = id.split('/');
    const value: CatalogModel | null =
      quants.length > 0
        ? {
            id,
            name: prettyName(repo ?? id),
            owner: owner ?? 'unknown',
            parameterSize: paramHint(repo ?? ''),
            tags: capabilityTags(info?.tags ?? [], repo ?? ''),
            quants,
            downloads: info?.downloads,
            license: info?.cardData?.license,
            gated: Boolean(info?.gated),
          }
        : null;
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * A repo's GGUF files as quantization options.
   *
   * Split models (`-00001-of-00003.gguf`) are collapsed onto their first shard
   * and carry the rest as `extraFiles`, because downloading one shard of three
   * produces a file that looks fine and cannot load.
   */
  async function quantsFor(id: string): Promise<CatalogQuant[]> {
    const tree = await getJson<Array<{ type?: string; path?: string; size?: number }>>(
      `${HF_API}/models/${id}/tree/main?recursive=true`,
    );
    if (!tree) return [];

    const ggufs = tree.filter((f) => f.type !== 'directory' && f.path?.toLowerCase().endsWith('.gguf'));
    const byGroup = new Map<string, Array<{ path: string; size: number }>>();
    for (const f of ggufs) {
      const path = f.path as string;
      // A projector is a companion for vision models, never a model on its own.
      if (/mmproj/i.test(path)) continue;
      const group = path.replace(/-\d{5}-of-\d{5}\.gguf$/i, '.gguf');
      const list = byGroup.get(group) ?? [];
      list.push({ path, size: f.size ?? 0 });
      byGroup.set(group, list);
    }

    const projector = ggufs.find((f) => /mmproj/i.test(f.path ?? ''))?.path;

    const quants: CatalogQuant[] = [];
    for (const [group, parts] of byGroup) {
      parts.sort((a, b) => a.path.localeCompare(b.path));
      const label = quantLabel(group);
      quants.push({
        label,
        file: parts[0].path,
        sizeBytes: parts.reduce((n, p) => n + p.size, 0),
        extraFiles: [...parts.slice(1).map((p) => p.path), ...(projector ? [projector] : [])],
        note: QUANT_NOTES[label],
      });
    }
    return quants.sort((a, b) => rank(a.label) - rank(b.label));
  }

  async function getJson<T>(url: string): Promise<T | null> {
    try {
      const res = await doFetch(url, { headers: headers() });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }

  return { curated, search, model, quantsFor };
}

export type Catalog = ReturnType<typeof createCatalog>;

/** The URL a repo file is fetched from. */
export function hfFileUrl(repoId: string, file: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`;
}

/** `...-Q4_K_M.gguf` -> `Q4_K_M`, falling back to the bare file name. */
function quantLabel(file: string): string {
  const base = file.split('/').pop() ?? file;
  const m = base.match(/[-_.]((?:IQ|Q)\d+[A-Z0-9_]*|BF16|F16|F32|MXFP4[A-Z0-9_]*)\.gguf$/i);
  return m ? m[1].toUpperCase() : base.replace(/\.gguf$/i, '');
}

function rank(label: string): number {
  const i = QUANT_ORDER.findIndex((q) => label.toUpperCase().startsWith(q));
  return i === -1 ? QUANT_ORDER.length : i;
}

function prettyName(repo: string): string {
  return repo.replace(/[-_]?GGUF$/i, '').replace(/[-_]/g, ' ').trim();
}

/** `Qwen2.5-7B-Instruct` -> `7B`. Display only; never used for sizing. */
function paramHint(repo: string): string | undefined {
  return repo.match(/(\d+(?:\.\d+)?[BM])(?![a-z])/i)?.[1]?.toUpperCase();
}

/**
 * Capability tags, from the repo's own tags plus the name.
 *
 * Name matching is a hint, not a claim: it decides which chips a card shows, and
 * nothing downstream depends on it being right.
 */
function capabilityTags(hfTags: string[], repo: string): string[] {
  const text = `${hfTags.join(' ')} ${repo}`.toLowerCase();
  const tags: string[] = [];
  if (/embed|bge|e5-|gte-/.test(text)) tags.push('embedding');
  else tags.push('chat');
  if (/coder|code|starcoder|deepseek-?coder/.test(text)) tags.push('code');
  if (/reason|r1|qwq|thinking|gpt-oss/.test(text)) tags.push('reasoning');
  if (/vision|vl|multimodal|llava|gemma-3/.test(text)) tags.push('vision');
  return tags;
}
