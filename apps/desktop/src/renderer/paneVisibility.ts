import { createContext, useContext } from 'react';

/**
 * Whether the window a component lives in is on screen.
 *
 * The workspace view keeps the chats you used last mounted behind
 * `display: none`, so returning to one is a visibility flip instead of a
 * rebuild. Components inside use this to stop work nobody can see (repainting
 * a streaming reply, measuring) and to pick it back up when shown.
 */
export const PaneVisibleContext = createContext(true);

export function usePaneVisible(): boolean {
  return useContext(PaneVisibleContext);
}
