/**
 * Tab inside a markdown list, in the composer.
 *
 * A textarea moves focus on Tab. When the caret (or the selection) sits on
 * list lines, Tab indents them two spaces instead and Shift+Tab takes two back,
 * which is how a bullet becomes a sub-bullet in markdown. On any other line the
 * key is left alone, so Tab still leaves the box the way a form expects.
 */

/** `- item`, `* item`, `+ item`, `1. item`, `1) item`, `- [ ] task`, with any leading indent. */
const LIST_LINE = /^[ \t]*(?:[-*+]|\d+[.)])\s/;

export const LIST_INDENT = '  ';

export interface ListEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/**
 * The composer text with every list line the selection touches indented one
 * level (or outdented, for Shift+Tab), and where the selection lands after.
 * Null when the selection is not on a list line, so the caller lets the key
 * through.
 */
export function indentListSelection(text: string, selectionStart: number, selectionEnd: number, outdent: boolean): ListEdit | null {
  const from = Math.min(selectionStart, selectionEnd);
  const to = Math.max(selectionStart, selectionEnd);
  const lineStart = text.lastIndexOf('\n', from - 1) + 1;
  // A selection that ends right after a newline does not include that next line.
  const lastLineAnchor = to > from && text[to - 1] === '\n' ? to - 1 : to;
  const lineEndIdx = text.indexOf('\n', lastLineAnchor);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  if (!lines.some((l) => LIST_LINE.test(l))) return null;

  let firstDelta = 0;
  let totalDelta = 0;
  const edited = lines.map((line, i) => {
    let next = line;
    if (LIST_LINE.test(line)) {
      if (outdent) {
        const strip = line.startsWith(LIST_INDENT) ? LIST_INDENT.length : line.startsWith(' ') || line.startsWith('\t') ? 1 : 0;
        next = line.slice(strip);
      } else {
        next = LIST_INDENT + line;
      }
    }
    const delta = next.length - line.length;
    if (i === 0) firstDelta = delta;
    totalDelta += delta;
    return next;
  });
  const out = text.slice(0, lineStart) + edited.join('\n') + text.slice(lineEnd);
  // The caret keeps its place within its line; a collapsed caret on an
  // outdented line never moves before the line's start.
  const start = Math.max(lineStart, from + firstDelta);
  const end = to === from ? start : Math.max(start, to + totalDelta);
  return { text: out, selectionStart: start, selectionEnd: end };
}
