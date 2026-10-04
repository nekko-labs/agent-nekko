import React from 'react';

/**
 * The handle between two windows in a split tree. Pointer capture rather than
 * window listeners, so the drag keeps tracking over the panes' own iframes and
 * terminals (which would otherwise swallow it). Shared by the Agent tab's
 * workspaces and the Command Center wall, so a divider drags the same way
 * wherever two windows meet.
 */
export function Divider({
  splitId, index, dir, onResize,
}: {
  splitId: string; index: number; dir: 'row' | 'col';
  onResize: (splitId: string, index: number, fraction: number) => void;
}) {
  const row = dir === 'row';
  const start = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const handle = e.currentTarget;
    const area = handle.parentElement;
    if (!area) return;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = area.getBoundingClientRect();
      const span = row ? rect.width : rect.height;
      if (span <= 0) return;
      onResize(splitId, index, row ? (ev.clientX - rect.left) / span : (ev.clientY - rect.top) / span);
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label="Resize these windows"
      tabIndex={0}
      /* The gap between two panels is the handle: there is no line to draw any
         more, so the divider is the space itself and shows a grip on hover. */
      className={`group relative shrink-0 ${row ? 'cursor-col-resize' : 'cursor-row-resize'}`}
      style={{ [row ? 'width' : 'height']: 'var(--pane-gap)', touchAction: 'none' } as React.CSSProperties}
      onPointerDown={start}
    >
      <span
        /* A little wider than the gap, so the handle is grabbable without
           making the gap itself bigger than it should look. */
        className={`absolute ${row ? 'inset-y-0 -left-1 -right-1' : 'inset-x-0 -top-1 -bottom-1'}`}
      />
      <span
        aria-hidden
        className={`pane-grip absolute rounded-full opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-active:opacity-100 ${
          row ? 'inset-y-0 left-1/2 w-[3px] -translate-x-1/2' : 'inset-x-0 top-1/2 h-[3px] -translate-y-1/2'
        }`}
      />
    </div>
  );
}
