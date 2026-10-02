import React, { forwardRef } from 'react';

/**
 * Markdown cues behind the composer's textarea.
 *
 * The textarea keeps the text, the selection and the caret; this overlay sits
 * under it with the same box, font and padding, painting what markdown markup
 * will mean — a tinted `#`, an accent bullet, a quoted line gone soft — while
 * the textarea's own glyphs are transparent. It is the difference between
 * typing a message and typing markup you have to imagine rendered.
 *
 * One hard rule: only color and decoration may differ. A font weight or size
 * change shifts glyph widths, and the moment glyphs shift the overlay stops
 * sitting under the text it colors, so headings and bold are tinted, not
 * emboldened. `scrollbar-gutter: stable` on both sides keeps the wrap point
 * identical whether or not a scrollbar is out.
 */

const INK = 'var(--ink)';
const INK_SOFT = 'var(--ink-soft)';
const INK_FAINT = 'var(--ink-faint)';
const ACCENT = 'var(--accent)';
const CODE = 'var(--accent-2)';

const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g;

/** Style spans inside one line: emphasis, strike, inline code. */
function inlineNodes(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(<React.Fragment key={`${keyBase}t${last}`}>{text.slice(last, m.index)}</React.Fragment>);
    const tok = m[0];
    const key = `${keyBase}m${m.index}`;
    if (tok.startsWith('`')) {
      out.push(
        <span key={key}>
          <span style={{ color: INK_FAINT }}>`</span>
          <span style={{ color: CODE, background: 'var(--surface-2)', borderRadius: 3 }}>{tok.slice(1, -1)}</span>
          <span style={{ color: INK_FAINT }}>`</span>
        </span>,
      );
    } else if (tok.startsWith('~~')) {
      out.push(
        <span key={key}>
          <span style={{ color: INK_FAINT }}>~~</span>
          <span style={{ color: INK_FAINT, textDecoration: 'line-through' }}>{tok.slice(2, -2)}</span>
          <span style={{ color: INK_FAINT }}>~~</span>
        </span>,
      );
    } else {
      // Bold or italic: the marks fade, the words stay the composer's own ink.
      const marks = tok.startsWith('**') || tok.startsWith('__') ? 2 : 1;
      out.push(
        <span key={key}>
          <span style={{ color: INK_FAINT }}>{tok.slice(0, marks)}</span>
          {tok.slice(marks, -marks)}
          <span style={{ color: INK_FAINT }}>{tok.slice(-marks)}</span>
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<React.Fragment key={`${keyBase}e`}>{text.slice(last)}</React.Fragment>);
  return out;
}

/**
 * The draft as colored spans: block markers first (headings, lists, quotes,
 * fences), then inline marks inside what's left. Exported for tests.
 */
export function composerMarkdownNodes(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let inCode = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const key = `l${i}`;
    if (i > 0) out.push('\n');

    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      out.push(
        <span key={key} style={{ color: INK_FAINT }}>
          {line}
        </span>,
      );
      continue;
    }
    if (inCode) {
      out.push(
        <span key={key} style={{ color: INK_SOFT }}>
          {line}
        </span>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})(\s+.*)?$/);
    if (heading) {
      out.push(
        <span key={key}>
          <span style={{ color: ACCENT }}>{heading[1]}</span>
          {heading[2] ? <span style={{ color: INK }}>{inlineNodes(heading[2], key)}</span> : null}
        </span>,
      );
      continue;
    }
    const quote = line.match(/^(\s*>+)(.*)$/);
    if (quote) {
      out.push(
        <span key={key}>
          <span style={{ color: ACCENT }}>{quote[1]}</span>
          <span style={{ color: INK_SOFT }}>{inlineNodes(quote[2], key)}</span>
        </span>,
      );
      continue;
    }
    // A bullet needs whitespace after its marker, or `**bold**` and `1-2`
    // would read as lists.
    const list = line.match(/^(\s*)([-*+]|\d+[.)])(\s+\[[ xX]\])?(\s.*)?$/);
    if (list && (list[3] || list[4])) {
      out.push(
        <span key={key}>
          {list[1]}
          <span style={{ color: ACCENT }}>{list[2]}</span>
          {list[3] ? <span style={{ color: ACCENT }}>{list[3]}</span> : null}
          <span style={{ color: INK }}>{inlineNodes(list[4], key)}</span>
        </span>,
      );
      continue;
    }
    out.push(
      <span key={key} style={{ color: INK }}>
        {inlineNodes(line, key)}
      </span>,
    );
  }
  return out;
}

export const ComposerHighlight = forwardRef<HTMLDivElement, { text: string }>(function ComposerHighlight(
  { text },
  ref,
) {
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden px-3.5 pt-3 text-sm [scrollbar-gutter:stable]"
    >
      {/* A trailing newline keeps the last empty line's height honest, matching
          the line the textarea always leaves open under the caret. */}
      <div className="whitespace-pre-wrap break-words">{text ? composerMarkdownNodes(text) : null}
        {text ? '\n' : null}
      </div>
    </div>
  );
});
