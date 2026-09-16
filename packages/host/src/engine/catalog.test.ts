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
