import { createContext, useCallback, useContext, useState } from 'react';

/**
 * UI state that outlives a transcript row's DOM.
 *
 * The transcript only mounts the rows near the viewport, so a row scrolled far
 * away is unmounted and its local state (an expanded step list, a message
 * being edited) would reset on the way back. Rows keep that state here
 * instead: a map owned by the transcript, keyed by row and by a name the
 * component picks. Outside a transcript row it behaves like useState.
 */
export const RowMemoryContext = createContext<Map<string, unknown> | null>(null);
export const RowKeyContext = createContext<string | null>(null);

export function useRowState<T>(name: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const memory = useContext(RowMemoryContext);
  const row = useContext(RowKeyContext);
  const key = memory && row ? `${row}:${name}` : null;
  const [value, setValue] = useState<T>(() => (key && memory!.has(key) ? (memory!.get(key) as T) : initial));
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        if (key) memory!.set(key, resolved);
        return resolved;
      });
    },
    [key, memory],
  );
  return [value, set];
}
