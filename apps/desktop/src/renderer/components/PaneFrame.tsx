import React, { useState } from 'react';
import type { Direction, WbPane } from '../layout.js';
import { CloseIcon } from '../icons.js';
import { SplitCompass } from './SplitCompass.js';

/**
 * The chrome around one window in a workspace: a thin title strip that is also
 * the handle you drag it by, the compass that adds a window beside it, and a
 * close button.
 *
 * While any window is being dragged every window covers itself with a target
 * that reads the pointer's nearest edge, because the thing you drop onto is
 * usually a browser or a terminal that would otherwise swallow the drag before
 * this frame ever saw it.
 */

/** The private drag type, so a pane drag can't be confused with a file drop. */
export const PANE_DRAG_TYPE = 'application/x-nekko-pane';

/** Which edge of a rectangle a point is nearest — the side a drop lands on. */
export function edgeAt(rect: DOMRect, x: number, y: number): Direction {
  const nx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const ny = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  const toVertical = Math.min(nx, 1 - nx);
  const toHorizontal = Math.min(ny, 1 - ny);
  if (toVertical < toHorizontal) return nx < 0.5 ? 'left' : 'right';
  return ny < 0.5 ? 'up' : 'down';
}

/** The band a drop on that edge would fill, as a quarter of the window. */
const BAND: Record<Direction, React.CSSProperties> = {
  up: { top: 0, left: 0, right: 0, height: '35%' },
  down: { bottom: 0, left: 0, right: 0, height: '35%' },
  left: { left: 0, top: 0, bottom: 0, width: '35%' },
  right: { right: 0, top: 0, bottom: 0, width: '35%' },
};

export function PaneFrame({
  pane,
  title,
  icon,
  badge,
  isActive,
  dragging,
  canSplit,
  onSplit,
  onClose,
  onFocus,
  onDragStart,
  onDragEnd,
  onDrop,
  children,
}: {
  pane: WbPane;
  title: string;
  icon: React.ReactNode;
  /** Optional trailing chip (the project a chat belongs to, a status dot). */
  badge?: React.ReactNode;
  isActive: boolean;
  /** The window currently being dragged anywhere in this workspace, if any. */
  dragging: string | null;
  canSplit: (dir: Direction) => boolean;
  onSplit: (dir: Direction, kind: WbPane['kind']) => void;
  onClose: () => void;
  onFocus: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (dir: Direction) => void;
  children: React.ReactNode;
}) {
  const [over, setOver] = useState<Direction | null>(null);
  // A window can't be dropped on itself, so it shows no target for its own drag.
  const targeting = dragging !== null && dragging !== pane.id;

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{
        background: 'var(--paper)',
        boxShadow: isActive ? 'inset 0 0 0 1px var(--accent)' : 'inset 0 0 0 1px var(--line)',
      }}
      onMouseDown={onFocus}
    >
      <div
        className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1"
        style={{ background: isActive ? 'var(--surface-2)' : 'transparent', cursor: 'grab' }}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData(PANE_DRAG_TYPE, pane.id);
          // Some targets only see text/plain; harmless duplicate.
          e.dataTransfer.setData('text/plain', pane.id);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        title="Drag to move this window"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ fontWeight: isActive ? 500 : 400 }}>
          {title}
        </span>
        {badge}
        <SplitCompass kind={pane.kind} canSplit={canSplit} onSplit={onSplit} />
        <button
          className="rounded-sm p-1 text-ink-faint hover:text-ink"
          title="Close this window"
          aria-label={`Close ${title}`}
          onClick={onClose}
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {children}
        {targeting && (
          <div
            className="absolute inset-0 z-20"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const next = edgeAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
              if (next !== over) setOver(next);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              const dir = edgeAt(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY);
              setOver(null);
              onDrop(dir);
            }}
          >
            {over && <span aria-hidden className="pane-dropzone pane-dropzone-live" style={BAND[over]} />}
          </div>
        )}
      </div>
    </div>
  );
}
