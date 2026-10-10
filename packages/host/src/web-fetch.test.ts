import { describe, expect, it } from 'vitest';
import { FETCH_MAX_BYTES, decodeEntities, describeFetched, fetchUrl, htmlToText } from './web-fetch.js';

const page = `<!doctype html><html><head><title>Nekko Agent &amp; friends</title><style>p{color:red}</style>
<script>alert(1)</script></head><body><nav><a href="/docs">Docs</a></nav>
<h1>Welcome</h1><p>Local agent, <b>frontier</b> brains.&nbsp;See <a href="https://example.com/x">the guide</a> and <a href="#top">top</a>.</p>
<ul><li>One</li><li>Two &lt;3</li></ul><pre>npm i</pre><img alt="A cat" src="c.png"><!-- hidden --><p>Bye</p></body></html>`;

function fakeFetch(body: string, init: { status?: number; type?: string; url?: string } = {}): typeof fetch {
  return (async () =>
    new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' } })) as unknown as typeof fetch;
}

describe('htmlToText', () => {
  it('keeps the words, the headings, the lists and the links, and drops the rest', () => {
    const text = htmlToText(page, 'https://nekkoagent.com/');
    expect(text).toContain('# Nekko Agent & friends');
    expect(text).toContain('# Welcome');
    expect(text).toContain('Local agent, frontier brains. See the guide (https://example.com/x) and top.');
    expect(text).toContain('Docs (https://nekkoagent.com/docs)');
    expect(text).toContain('- One\n- Two <3');
    expect(text).toContain('`npm i`');
    expect(text).toContain('[image: A cat]');
    expect(text).not.toMatch(/alert|color:red|hidden/);
  });

  it('decodes entities by name and number', () => {
    expect(decodeEntities('a &amp; b &#169; &#x1F431; &unknown;')).toBe('a & b © 🐱 &unknown;');
  });
});

describe('fetchUrl', () => {
  it('fetches a page and hands back its text with a header line', async () => {
    const got = await fetchUrl('https://nekkoagent.com/', { fetchImpl: fakeFetch(page) });
    expect(got.status).toBe(200);
    expect(got.contentType).toBe('text/html');
    expect(got.text).toContain('# Welcome');
    expect(got.truncated).toBe(false);
    expect(describeFetched(got)).toMatch(/^https:\/\/nekkoagent\.com\/ \(HTTP 200, text\/html, [\d,]+ chars\)\n\n/);
  });

  it('cuts long text at max_chars and says so', async () => {
    const long = `<p>${'word '.repeat(10_000)}</p>`;
    const got = await fetchUrl('https://x.test/long', { fetchImpl: fakeFetch(long), maxChars: 1_000 });
    expect(got.text.length).toBe(1_000);
    expect(got.truncated).toBe(true);
    expect(describeFetched(got)).toContain('showing the first 1,000');
  });

  it('passes plain text and JSON through, refuses binaries and non-http URLs', async () => {
    const json = await fetchUrl('https://x.test/a.json', { fetchImpl: fakeFetch('{"a":1}', { type: 'application/json' }) });
    expect(json.text).toBe('{"a":1}');
    await expect(fetchUrl('https://x.test/a.pdf', { fetchImpl: fakeFetch('%PDF', { type: 'application/pdf' }) })).rejects.toThrow(/application\/pdf.*not text/);
    await expect(fetchUrl('file:///etc/passwd')).rejects.toThrow(/Only http and https/);
    await expect(fetchUrl('not a url')).rejects.toThrow(/Not a URL/);
  });

  it('stops reading at the byte cap', async () => {
    const huge = 'x'.repeat(FETCH_MAX_BYTES + 500_000);
    const got = await fetchUrl('https://x.test/huge', { fetchImpl: fakeFetch(huge, { type: 'text/plain' }), maxChars: 100_000 });
    expect(got.totalChars).toBeLessThanOrEqual(FETCH_MAX_BYTES);
    expect(got.truncated).toBe(true);
  });
});
