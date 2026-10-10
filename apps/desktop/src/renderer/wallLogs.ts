import { create } from 'zustand';

/**
 * Which agent's command log is out on the Agents wall. One at a time: the log
 * slides out of its window's right edge as a drawer of its own, and the wall
 * makes room for it. `closing` keeps the drawer mounted while it is absorbed
 * back into the window, but the wall already lays out as if it were gone so
 * the neighbours slide back at the same time.
 */
export interface WallLogsState {
  sessionId: string | null;
  closing: boolean;
  toggle: (sessionId: string) => void;
  close: () => void;
  /** The close animation finished: unmount the drawer. */
  closed: () => void;
}

export const useWallLogs = create<WallLogsState>((set, get) => ({
  sessionId: null,
  closing: false,
  toggle: (sessionId) => {
    const s = get();
    if (s.sessionId === sessionId && !s.closing) set({ closing: true });
    else set({ sessionId, closing: false });
  },
  close: () => { if (get().sessionId) set({ closing: true }); },
  closed: () => { if (get().closing) set({ sessionId: null, closing: false }); },
}));

export interface Rect { x: number; y: number; width: number; height: number }

/** The drawer's share of the target window's height. */
export const LOGS_DRAWER_HEIGHT = 0.9;
const MIN_DRAWER = 280;
const MIN_CHAT = 320;
/** The narrowest a window beside the drawer is squeezed to. */
const MIN_SIDE = 240;

export function logsDrawerWidth(stageWidth: number): number {
  return Math.round(Math.max(340, Math.min(560, stageWidth * 0.32)));
}

/**
 * Lay the wall out around an open log drawer. The drawer hangs off the target
 * window's right edge at 90% of its height, vertically centred. Windows to the
 * right that share its rows slide right by the drawer's width, squeezed into
 * what is left of the stage when they can stay usable; the target narrows
 * when it is the rightmost window and nothing else can give way. Pure: the
 * saved layout is never touched.
 */
export function layoutWithLogsDrawer(
  panes: Map<string, Rect>,
  targetId: string,
  stageWidth: number,
): { panes: Map<string, Rect>; drawer: Rect | null } {
  const t = panes.get(targetId);
  if (!t || stageWidth <= 0) return { panes, drawer: null };
  const next = new Map(panes);
  let width = logsDrawerWidth(stageWidth);
  const right = t.x + t.width;
  const top = t.y, bottom = t.y + t.height;
  const beside = [...panes].filter(([id, r]) => id !== targetId && r.x >= right - 1 && r.y < bottom - 1 && r.y + r.height > top + 1);

  let targetWidth = t.width;
  if (beside.length === 0) {
    // Nothing to push: take the room from the window's own width.
    const room = stageWidth - right;
    if (room < width) targetWidth = Math.max(Math.min(t.width, MIN_CHAT), stageWidth - t.x - width);
    width = Math.max(MIN_DRAWER, Math.min(width, stageWidth - (t.x + targetWidth)));
  } else {
    // Squeeze the neighbours into what is left, never below MIN_SIDE each; the
    // drawer itself gives way (down to MIN_DRAWER) before anything is pushed
    // off the wall. Only when even that cannot fit do they slide right whole.
    const region = stageWidth - right;
    const minScale = Math.max(...beside.map(([, r]) => MIN_SIDE / Math.max(1, r.width)));
    width = Math.round(Math.max(MIN_DRAWER, Math.min(width, region * (1 - minScale))));
    const squeeze = region > width ? (region - width) / region : 0;
    const usable = squeeze >= minScale - 1e-9;
    for (const [id, r] of beside) {
      next.set(id, usable
        ? { ...r, x: right + width + (r.x - right) * squeeze, width: r.width * squeeze }
        : { ...r, x: r.x + width });
    }
  }
  next.set(targetId, { ...t, width: targetWidth });
  const h = Math.round(t.height * LOGS_DRAWER_HEIGHT);
  return { panes: next, drawer: { x: t.x + targetWidth, y: t.y + Math.round((t.height - h) / 2), width, height: h } };
}
