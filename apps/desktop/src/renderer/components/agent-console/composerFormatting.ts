import type { MarkdownEdit } from './MarkdownEditor.js';

export const markdownControls = [
  ['bold', 'Bold', 'B'], ['italic', 'Italic', 'I'], ['strike', 'Strikethrough', 'S'],
  ['code', 'Inline code', '<>'], ['link', 'Link', '↗'], ['heading', 'Heading', 'H'],
  ['bullet', 'Bulleted list', '•'], ['ordered', 'Numbered list', '1.'],
  ['task', 'Task list', '☑'], ['quote', 'Quote', '❯'], ['fence', 'Code block', '```'],
] as const;
export type MarkdownAction = typeof markdownControls[number][0];
const marks: Partial<Record<MarkdownAction, string>> = { bold: '**', italic: '*', strike: '~~', code: '`' };
const prefixes: Partial<Record<MarkdownAction, RegExp>> = {
  heading: /^#{1,6} /, bullet: /^[-+*] (?!\[[ xX]\] )/, ordered: /^\d+[.)] /,
  task: /^[-+*] \[[ xX]\] /, quote: /^> /,
};
function block(text: string, start: number, end: number) {
  const from = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1;
  const last = text.indexOf('\n', Math.max(start, end - 1));
  return { from, to: last < 0 ? text.length : last };
}
function inlineSpan(text: string, start: number, end: number, mark: string) {
  if (start === end && start >= mark.length && text.slice(start - mark.length, start) === mark && text.slice(end, end + mark.length) === mark) return { from: start, to: end };
  const escaped = Array.from(mark).map(char => '\\' + char).join('');
  const regex = new RegExp(`${escaped}[^\\n]+?${escaped}`, 'g');
  for (const match of text.matchAll(regex)) {
    const from = match.index + mark.length;
    const to = match.index + match[0].length - mark.length;
    // Single emphasis/code markers must not mistake double markers for a span.
    if (mark.length === 1 && (text[from] === mark || text[to - 1] === mark || text[match.index - 1] === mark)) continue;
    if (start >= from && end <= to) return { from, to };
  }
  return null;
}
export function markdownActive(text: string, start: number, end: number, action: MarkdownAction): boolean {
  const mark = marks[action];
  if (mark) return inlineSpan(text, start, end, mark) !== null;
  if (action === 'fence') return text.slice(0, start).endsWith('```\n') && text.slice(end).startsWith('\n```');
  if (action === 'link') return text[start - 1] === '[' && /^\]\([^\n]*\)/.test(text.slice(end));
  const { from, to } = block(text, start, end);
  return text.slice(from, to).split('\n').every(line => prefixes[action]?.test(line.trimStart()));
}
export function formatMarkdown(text: string, start: number, end: number, action: MarkdownAction): MarkdownEdit {
  const active = markdownActive(text, start, end, action);
  const mark = marks[action];
  if (mark || action === 'link' || action === 'fence') {
    const left = mark ?? (action === 'link' ? '[' : '```\n');
    const right = mark ?? (action === 'link' ? '](url)' : '\n```');
    const removeRight = action === 'link' ? text.slice(end).match(/^\]\([^\n]*\)/)?.[0].length ?? right.length : right.length;
    const span = mark ? inlineSpan(text, start, end, mark) : null;
    return active
      ? { text: text.slice(0, (span?.from ?? start) - left.length) + text.slice(span?.from ?? start, span?.to ?? end) + text.slice((span?.to ?? end) + removeRight), start: start - left.length, end: end - left.length }
      : { text: text.slice(0, start) + left + text.slice(start, end) + right + text.slice(end), start: start + left.length, end: end + left.length };
  }
  const { from, to } = block(text, start, end);
  const lines = text.slice(from, to).split('\n');
  const updated = lines.map((line, i) => {
    const indent = line.match(/^\s*/)?.[0] ?? '';
    const body = line.slice(indent.length).replace(/^(?:#{1,6} |[-+*] (?:\[[ xX]\] )?|\d+[.)] |> )/, '');
    const prefix = active ? '' : action === 'heading' ? '## ' : action === 'bullet' ? '- ' : action === 'ordered' ? `${i + 1}. ` : action === 'task' ? '- [ ] ' : '> ';
    return indent + prefix + body;
  });
  const replacement = updated.join('\n');
  return { text: text.slice(0, from) + replacement + text.slice(to), start: Math.max(from, start + updated[0].length - lines[0].length), end: Math.max(from, end + replacement.length - (to - from)) };
}

/** Convert detached clipboard HTML to Markdown; never mount it or fetch resources. */
export function clipboardMarkdown(html: string, plain: string): string {
  if (!html) return plain.replace(/\r\n?/g, '\n');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? '').replace(/([\\`*_\[\]~])/g, '\\$1');
    if (node.nodeType !== 1) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'iframe', 'object', 'img', 'svg'].includes(tag)) return '';
    const inner = Array.from(el.childNodes).map(walk).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return `**${inner}**`;
    if (tag === 'em' || tag === 'i') return `*${inner}*`;
    if (['s', 'del', 'strike'].includes(tag)) return `~~${inner}~~`;
    if (tag === 'pre') return `\n\n\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n\n`;
    if (tag === 'code') return `\`${el.textContent ?? ''}\``;
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      return /^(https?:|mailto:)/i.test(href) ? `[${inner}](${href.replace(/\(/g, '%28').replace(/\)/g, '%29')})` : inner;
    }
    if (/^h[1-6]$/.test(tag)) return `\n\n${'#'.repeat(Number(tag[1]))} ${inner}\n\n`;
    if (tag === 'li') {
      const index = Array.from(el.parentElement?.children ?? []).indexOf(el) + 1;
      return `${el.parentElement?.tagName === 'OL' ? `${index}.` : '-'} ${inner.trim()}\n`;
    }
    if (tag === 'blockquote') return `\n\n${inner.trim().split('\n').map(line => '> ' + line).join('\n')}\n\n`;
    if (['p', 'div', 'ul', 'ol'].includes(tag)) return `\n\n${inner}\n\n`;
    return inner;
  };
  return Array.from(doc.body.childNodes).map(walk).join('').replace(/\n{3,}/g, '\n\n').trim() || plain.replace(/\r\n?/g, '\n');
}
