/**
 * `fetch_url`: a page or a file from the web, as text the model can read.
 *
 * Every comparable agent has one (Claude Code's WebFetch, Codex's and
 * OpenClaw's fetch tools); here the only way to a URL was the browser tool,
 * which needs a visible Chromium window and an approval per action. This is
 * the plain version: one GET, a size and time limit, HTML reduced to text
 * with its links kept, and the head of the result handed back. It does not
 * run scripts, follow logins, or search; the browser tool still does those.
 */

/** Longest a fetch may take, connect and body included. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Most bytes read from a response. */
export const FETCH_MAX_BYTES = 2_000_000;
/** Default characters handed to the model. */
export const FETCH_DEFAULT_CHARS = 20_000;
/** Ceiling on `max_chars`. */
export const FETCH_MAX_CHARS = 100_000;

const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'ul', 'ol', 'li', 'table', 'tr', 'blockquote', 'pre', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'form', 'hr', 'address', 'details', 'summary']);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * HTML to readable text: scripts, styles and hidden boilerplate dropped,
 * headings marked, lists bulleted, links kept as `text (href)` so the model
 * can follow them, whitespace folded. A regex pass, not a DOM: good enough
 * for docs, articles, READMEs and API references, which is what gets fetched.
 */
export function htmlToText(html: string, baseUrl?: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!doctype[^>]*>/gi, '');
  s = s.replace(/<(script|style|noscript|svg|canvas|template|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<head\b[\s\S]*?<\/head\s*>/gi, (head) => {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
    return title ? `<h1>${title}</h1>` : '';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${'#'.repeat(Number(n))} `);
  s = s.replace(/<\/h[1-6]\s*>/gi, '\n\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  // A closing </li> adds no line of its own; the next <li> opens one.
  s = s.replace(/<\/li\s*>/gi, '');
  s = s.replace(/<(td|th)\b[^>]*>/gi, ' | ');
  s = s.replace(/<(pre|code)\b[^>]*>/gi, '`');
  s = s.replace(/<\/(pre|code)\s*>/gi, '`');
  s = s.replace(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_, _q: string, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!label) return '';
    if (/^(#|javascript:|mailto:)/i.test(href)) return label;
    let abs = href;
    if (baseUrl) {
      try { abs = new URL(href, baseUrl).toString(); } catch { /* keep as written */ }
    }
    return abs === label ? label : `${label} (${abs})`;
  });
  s = s.replace(/<img\b[^>]*alt\s*=\s*(["'])(.*?)\1[^>]*>/gi, (_, _q: string, alt: string) => (alt.trim() ? `[image: ${alt.trim()}]` : ''));
  s = s.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (_, tag: string) => (BLOCK_TAGS.has(tag.toLowerCase()) ? '\n' : ''));
  s = decodeEntities(s);
  s = s.replace(/[ \t\r\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  /** The readable text, cut to `maxChars`. */
  text: string;
  /** Characters of readable text before the cut. */
  totalChars: number;
  truncated: boolean;
}

/**
 * GET a URL and reduce it to text. Only http(s); a redirect is followed by
 * fetch itself. Binary types are refused with their type named, so the model
 * does not read a PDF as mojibake.
 */
export async function fetchUrl(rawUrl: string, opts: { maxChars?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error(`Not a URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https URLs can be fetched (got ${url.protocol}).`);
  const maxChars = Math.min(Math.max(1_000, Math.round(opts.maxChars ?? FETCH_DEFAULT_CHARS)), FETCH_MAX_CHARS);
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url.toString(), {
      signal,
      redirect: 'follow',
      headers: {
        accept: 'text/html, application/xhtml+xml, text/plain;q=0.9, application/json;q=0.8, */*;q=0.5',
        'accept-language': 'en, *;q=0.5',
        'user-agent': 'Mozilla/5.0 (compatible; NekkoAgent/1.0; +https://nekkoagent.com)',
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    throw new Error(/abort|timeout/i.test(msg) && timeout.aborted ? `Fetching ${url} took longer than ${FETCH_TIMEOUT_MS / 1000} s.` : `Could not fetch ${url}: ${msg}`);
  }
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const kind = contentType.split(';')[0].trim();
  const textual = !kind || kind.startsWith('text/') || /json|xml|javascript|yaml|csv|markdown|x-sh|x-www-form-urlencoded/.test(kind);
  if (!textual) {
    throw new Error(`${url} is ${kind || 'binary'} (${res.headers.get('content-length') ?? 'unknown'} bytes), not text. Download it with bash (curl) if you need it.`);
  }
  // Read up to the byte cap, then stop pulling.
  let bytes = new Uint8Array(0);
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= FETCH_MAX_BYTES) {
        reader.cancel().catch(() => {});
        break;
      }
    }
    bytes = new Uint8Array(Math.min(total, FETCH_MAX_BYTES));
    let offset = 0;
    for (const c of chunks) {
      const slice = c.subarray(0, Math.min(c.byteLength, bytes.byteLength - offset));
      bytes.set(slice, offset);
      offset += slice.byteLength;
      if (offset >= bytes.byteLength) break;
    }
  }
  const charset = /charset=([^;\s]+)/.exec(contentType)?.[1];
  let raw: string;
  try {
    raw = new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    raw = new TextDecoder('utf-8').decode(bytes);
  }
  const isHtml = kind.includes('html') || (!kind && /<html[\s>]|<body[\s>]|<!doctype html/i.test(raw.slice(0, 2_000)));
  const full = isHtml ? htmlToText(raw, res.url || url.toString()) : raw.trim();
  const truncated = full.length > maxChars;
  return {
    url: url.toString(),
    finalUrl: res.url || url.toString(),
    status: res.status,
    contentType: kind,
    text: truncated ? full.slice(0, maxChars) : full,
    totalChars: full.length,
    truncated,
  };
}

/** The tool's output for a fetched page. */
export function describeFetched(page: FetchedPage): string {
  const where = page.finalUrl !== page.url ? `${page.url} → ${page.finalUrl}` : page.url;
  const head = `${where} (HTTP ${page.status}${page.contentType ? `, ${page.contentType}` : ''}, ${page.totalChars.toLocaleString()} chars${page.truncated ? `, showing the first ${page.text.length.toLocaleString()}` : ''})`;
  return `${head}\n\n${page.text || '(no readable text)'}`;
}
