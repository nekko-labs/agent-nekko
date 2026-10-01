import { describe, expect, it } from 'vitest';
import { createCatalog, stripFrontMatter } from './catalog.js';

/**
 * The catalog, against a stubbed Hugging Face.
 *
 * What matters here is the shape the model page needs: the numbers people judge
 * a repo by (downloads, likes, when it last moved), and a card that arrives as
 * prose rather than as the YAML block the Hub puts in front of it.
 */

/** A fetch that answers from a table of URL fragments. */
function stubFetch(routes: Array<[RegExp, unknown | string]>): typeof fetch {
  return (async (url: string) => {
    for (const [pattern, body] of routes) {
      if (!pattern.test(String(url))) continue;
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => String(body),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => null, text: async () => '' } as Response;
  }) as unknown as typeof fetch;
}

const TREE = [
  { type: 'file', path: 'model-Q4_K_M.gguf', size: 4_000_000_000 },
  { type: 'file', path: 'model-Q8_0.gguf', size: 8_000_000_000 },
];

const TREE_WITH_SIDECARS = [
  { type: 'file', path: 'vision-00001-of-00002.gguf', size: 4_000_000_000 },
  { type: 'file', path: 'vision-00002-of-00002.gguf', size: 3_000_000_000 },
  { type: 'file', path: 'mmproj-vision-f16.gguf', size: 900_000_000 },
  { type: 'file', path: 'chat_template.jinja', size: 4_000 },
  { type: 'file', path: 'tokenizer_config.json', size: 30_000 },
  { type: 'file', path: 'weights.safetensors', size: 90_000_000_000 },
];

describe('catalog detail', () => {
  it('carries the numbers a model page is judged on', async () => {
    const catalog = createCatalog({
      fetch: stubFetch([
        [
          /api\/models\/owner\/repo$/,
          {
            id: 'owner/repo',
            downloads: 190_000,
            likes: 75,
            lastModified: '2024-09-19T00:00:00.000Z',
            createdAt: '2024-09-16T00:00:00.000Z',
            pipeline_tag: 'text-generation',
            tags: ['gguf', 'base_model:Qwen/Qwen2.5-7B', 'license:apache-2.0'],
          },
        ],
        [/tree\/main/, TREE],
        [/README\.md$/, '---\ntags:\n  - gguf\n---\n\n# Card\n\nProse.'],
      ]),
    });

    const detail = await catalog.detail('owner/repo');
    expect(detail?.downloads).toBe(190_000);
    expect(detail?.likes).toBe(75);
    expect(detail?.pipelineTag).toBe('text-generation');
    expect(detail?.baseModel).toBe('Qwen/Qwen2.5-7B');
    // The license is a tag when `cardData` does not spell it out.
    expect(detail?.license).toBe('apache-2.0');
    expect(detail?.quants.map((q) => q.label)).toEqual(['Q4_K_M', 'Q8_0']);
    expect(detail?.readme).toBe('# Card\n\nProse.');
  });

  it('says so when the card could not be read, rather than claiming there is none', async () => {
    const catalog = createCatalog({
      fetch: (async (url: string) => {
        if (String(url).endsWith('README.md')) throw new Error('offline');
        return {
          ok: true,
          status: 200,
          json: async () => (String(url).includes('tree') ? TREE : { id: 'owner/repo' }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    const detail = await catalog.detail('owner/repo');
    expect(detail?.readme).toBeUndefined();
    expect(detail?.readmeError).toMatch(/Hugging Face/);
  });

  it('carries every file the model needs to run: shards, projector, and configs', async () => {
    const catalog = createCatalog({
      fetch: stubFetch([
        [/api\/models\/owner\/vision$/, { id: 'owner/vision' }],
        [/tree\/main/, TREE_WITH_SIDECARS],
      ]),
    });
    const model = await catalog.model('owner/vision');
    const quant = model?.quants[0];
    // The first shard is the download; the second shard, the projector, and the
    // config files ride along as extras. The 90 GB safetensors is not a sidecar.
    expect(quant?.file).toBe('vision-00001-of-00002.gguf');
    expect(quant?.extraFiles).toEqual(
      expect.arrayContaining([
        'vision-00002-of-00002.gguf',
        'mmproj-vision-f16.gguf',
        'chat_template.jinja',
        'tokenizer_config.json',
      ]),
    );
    expect(quant?.extraFiles).not.toContain('weights.safetensors');
  });

  it('has no page for a repo that publishes no GGUF', async () => {
    const catalog = createCatalog({ fetch: stubFetch([[/tree\/main/, []], [/api\/models/, { id: 'owner/repo' }]]) });
    expect(await catalog.detail('owner/repo')).toBeNull();
  });
});

describe('stripFrontMatter', () => {
  it('drops the YAML block the Hub puts above the prose', () => {
    expect(stripFrontMatter('---\nlicense: mit\ntags:\n  - gguf\n---\n\nHello.')).toBe('Hello.');
  });

  it('leaves a card that does not open with one alone', () => {
    expect(stripFrontMatter('# Title\n\nBody.')).toBe('# Title\n\nBody.');
  });

  it('leaves an unterminated block alone rather than eating the whole card', () => {
    expect(stripFrontMatter('---\nnot closed\n\nstill the card')).toContain('still the card');
  });

  it('survives the CRLF a Windows-authored card arrives with', () => {
    expect(stripFrontMatter('---\r\nlicense: mit\r\n---\r\n\r\nHello.')).toBe('Hello.');
  });
});

describe('MLX checkpoints', () => {
  const MLX_TREE = [
    { type: 'file', path: 'config.json', size: 1_000 },
    { type: 'file', path: 'model-00001-of-00002.safetensors', size: 3_000_000_000 },
    { type: 'file', path: 'model-00002-of-00002.safetensors', size: 1_000_000_000 },
    { type: 'file', path: 'model.safetensors.index.json', size: 50_000 },
    { type: 'file', path: 'tokenizer.json', size: 7_000_000 },
    { type: 'file', path: 'tokenizer_config.json', size: 5_000 },
    { type: 'file', path: 'README.md', size: 9_000 },
    { type: 'file', path: 'figure.png', size: 400_000 },
    { type: 'directory', path: 'sub' },
    { type: 'file', path: 'sub/other.safetensors', size: 1 },
  ];

  it('offers an MLX repo as one whole-folder download, weights first', async () => {
    const catalog = createCatalog({ fetch: stubFetch([[/tree\/main/, MLX_TREE]]), mlx: () => true });
    const [q] = await catalog.quantsFor('mlx-community/Qwen3-4B-4bit');
    expect(q).toMatchObject({ label: '4bit', format: 'mlx', file: 'model-00001-of-00002.safetensors' });
    expect(q.extraFiles).toEqual(['config.json', 'model-00002-of-00002.safetensors', 'model.safetensors.index.json', 'tokenizer.json', 'tokenizer_config.json']);
    expect(q.sizeBytes).toBe(3_000_000_000 + 1_000_000_000 + 1_000 + 50_000 + 7_000_000 + 5_000);
  });

  it('does not call a plain safetensors repo MLX, and keeps GGUF repos GGUF', async () => {
    const catalog = createCatalog({ fetch: stubFetch([[/tree\/main/, MLX_TREE]]), mlx: () => true });
    expect(await catalog.quantsFor('meta-llama/Llama-3.1-8B')).toEqual([]);
    // Unless Hugging Face tags it mlx.
    expect((await catalog.quantsFor('someone/Finetune-4bit', ['mlx']))[0]).toMatchObject({ format: 'mlx', label: '4bit' });
    const gguf = createCatalog({ fetch: stubFetch([[/tree\/main/, TREE]]) });
    expect((await gguf.quantsFor('someone/model-mlx-GGUF')).every((q) => q.format === undefined)).toBe(true);
  });

  it('lists the MLX folder after the GGUF builds when a repo ships both', async () => {
    const both = createCatalog({ fetch: stubFetch([[/tree\/main/, [...TREE, ...MLX_TREE]]]), mlx: () => true });
    const quants = await both.quantsFor('someone/Model-27B', ['mlx']);
    expect(quants.map((q) => q.format ?? 'gguf')).toEqual(['gguf', 'gguf', 'mlx']);
  });

  it('never offers an MLX folder where MLX cannot run', async () => {
    const off = createCatalog({ fetch: stubFetch([[/tree\/main/, MLX_TREE]]), mlx: () => false });
    expect(await off.quantsFor('mlx-community/Qwen3-4B-4bit')).toEqual([]);
  });

  it('searches MLX checkpoints by tag, even with an empty query', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(String(url));
      if (/\/models\?/.test(String(url))) return { ok: true, json: async () => [{ id: 'mlx-community/Qwen3-4B-4bit', downloads: 9 }] } as Response;
      return { ok: true, json: async () => MLX_TREE } as Response;
    }) as unknown as typeof globalThis.fetch;
    const res = await createCatalog({ fetch, mlx: () => true }).search('', 20, 'mlx');
    expect(urls[0]).toMatch(/models\?filter=mlx&pipeline_tag=text-generation&search=&/);
    expect(res.map((m) => [m.id, m.quants[0].format])).toEqual([['mlx-community/Qwen3-4B-4bit', 'mlx']]);
  });
});
