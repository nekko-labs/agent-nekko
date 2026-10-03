/**
 * Just enough Markdown for chat replies: fenced code, headings, lists,
 * quotes, paragraphs, and inline bold/italic/code/links. Pure, so the
 * renderer stays dumb and the parsing is tested. Unclosed fences (a reply
 * still streaming) render as code up to the end.
 */
export type MdBlock =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string };

export type MdSpan = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

export function parseBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'para', text: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      out.push({ kind: 'code', lang: fence[1] ?? '', text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      out.push({ kind: 'heading', level: h[1].length, text: h[2].trim() });
      continue;
    }
    const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const prev = out[out.length - 1];
      if (prev?.kind === 'list' && prev.ordered === ordered) prev.items.push(li[2]);
      else out.push({ kind: 'list', ordered, items: [li[2]] });
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flush();
      const prev = out[out.length - 1];
      if (prev?.kind === 'quote') prev.text += `\n${q[1]}`;
      else out.push({ kind: 'quote', text: q[1] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A wrapped list item continues on an indented line.
    const prev = out[out.length - 1];
    if (!para.length && prev?.kind === 'list' && /^\s{2,}\S/.test(line)) {
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

export function parseInline(src: string): MdSpan[] {
  const out: MdSpan[] = [];
  // `_x_` is italic only at word edges, so snake_case identifiers stay as written.
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*|(?<!\w)_[^_\s][^_\n]*_(?!\w))|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    const t = m[0];
    if (m[1]) out.push({ text: t.slice(1, -1), code: true });
    else if (m[2] || m[3]) out.push({ text: t.slice(2, -2), bold: true });
    else if (m[4]) out.push({ text: t.slice(1, -1), italic: true });
    else {
      const link = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push({ text: link[1], href: link[2] });
    }
    last = m.index + t.length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

/** One-line plain text for list previews and titles: no fences, markers or link syntax. */
export function plainText(src: string): string {
  return src
    .replace(/```[\w+-]*\n?/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}
