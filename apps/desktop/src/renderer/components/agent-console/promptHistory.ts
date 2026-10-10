import type { Session } from '@nekko-agent/shared';

export function promptHistory(messages: Session['messages']): string[] {
  return messages.filter((m) => m.role === 'user')
    .map((m) => m.skill ? m.skill.input : m.content)
    .filter((text) => text.trim().length > 0);
}

export interface HistoryCursor { index: number; text: string }

/** Plain arrows recall prompts only at a line boundary, leaving text editing intact. */
export function recallPrompt(
  history: string[], cursor: HistoryCursor | null, draft: string,
  direction: 'ArrowUp' | 'ArrowDown', start: number, end: number,
): HistoryCursor | null {
  if (!history.length || start !== end) return null;
  const browsing = cursor?.text === draft ? cursor : null;
  if (direction === 'ArrowUp' && draft.slice(0, start).includes('\n')) return null;
  if (direction === 'ArrowDown' && draft.slice(end).includes('\n')) return null;
  if (direction === 'ArrowDown' && !browsing) return null;
  const index = direction === 'ArrowUp'
    ? Math.max(0, (browsing?.index ?? history.length) - 1)
    : Math.min(history.length, browsing!.index + 1);
  return { index, text: history[index] ?? '' };
}
