import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agent-nekko/shared';
import { ChatPane } from './ChatPane.js';
import { ChatIcon, ExternalIcon, LayoutIcon } from '../icons.js';
import { type ComposerDock, type ComposerAlign, type ComposerSide } from '../commandWall.js';

/** One agent window the composer can be pointed at: its number on the wall and what it is doing. */
export interface WallAgent {
  session: SessionSummary;
  /** 1-based position among the wall's agent windows, in reading order. */
  n: number;
  status: { label: string; tone: string; live?: boolean } | null;
}

const SIDES: ComposerSide[] = ['top', 'bottom'];
const ALIGNS: ComposerAlign[] = ['left', 'center', 'right'];
const DOCK_LABEL: Record<ComposerSide, string> = { top: 'Top', bottom: 'Bottom' };
const ALIGN_LABEL: Record<ComposerAlign, string> = { left: 'left', center: 'centre', right: 'right' };

/**
 * The one composer for the whole wall. It belongs to whichever agent window
 * is selected (a click on the window, Ctrl+Tab, or Ctrl+1…9), and shows that
 * chat's own controls: model, mode, tools, image settings when it is an image
 * chat, the queue, the question it is asking. The windows themselves show
 * only their transcripts. It docks to one of six places around the wall and a
 * tether drawn by the view joins it to the window it is speaking for.
 */
export function WallComposer({
  agent,
  agents,
  dock,
  onDock,
  onSelect,
  onOpen,
  onNewAgent,
  panelRef,
}: {
  agent: WallAgent | null;
  agents: WallAgent[];
  dock: ComposerDock;
  onDock: (dock: ComposerDock) => void;
  onSelect: (sessionId: string) => void;
  onOpen: (sessionId: string) => void;
  onNewAgent: () => void;
  /** The view measures the panel to draw the tether from it. */
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [pickerOpen]);

  // A newly selected agent gets the caret: selecting from the wall or the
  // keyboard means "talk to this one", so typing can start at once.
  useLayoutEffect(() => {
    if (!agent) return;
    const id = requestAnimationFrame(() => {
      const input = panelRef.current?.querySelector<HTMLElement>('.composer [contenteditable="true"], .composer textarea');
      if (input && document.activeElement !== input && !panelRef.current?.contains(document.activeElement)) input.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [agent?.session.id, panelRef]);

  const alignClass = dock.align === 'left' ? 'self-start' : dock.align === 'right' ? 'self-end' : 'self-center';

  return (
    <div
      ref={panelRef}
      className={`panel panel-ring wall-composer flex w-full max-w-[820px] shrink-0 flex-col ${alignClass}`}
      style={{ '--panel-ring-color': agent ? 'color-mix(in srgb, var(--accent) 55%, var(--line))' : 'var(--line)' } as React.CSSProperties}
      data-wall-composer
      data-dock={`${dock.side}-${dock.align}`}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1 text-[12px]">
        <ChatIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        {agent ? (
          <>
            <span className="wall-num" title={`Window ${agent.n}: Ctrl+${agent.n} selects it`}>{agent.n}</span>
            <span className="min-w-0 truncate font-medium" data-composer-title>{agent.session.title}</span>
            {agent.status && (
              <span className="flex min-w-0 items-center gap-1 text-[11px]" style={{ color: agent.status.tone }}>
                {agent.status.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: agent.status.tone }} />}
                <span className="truncate">{agent.status.label}</span>
              </span>
            )}
          </>
        ) : (
          <span className="text-ink-faint" data-composer-title>No agent selected</span>
        )}
        <span className="hidden text-[11px] text-ink-faint md:inline" style={{ marginLeft: 8 }}>
          {agents.length > 1 ? 'Ctrl+Tab cycles windows · Ctrl+1…9 picks one' : agents.length === 1 ? '' : ''}
        </span>
        <div className="min-w-0 flex-1" />
        {agent && (
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title={`Open ${agent.session.title} in the Agent tab`} aria-label={`Open ${agent.session.title} in the Agent tab`} onClick={() => onOpen(agent.session.id)}>
            <ExternalIcon className="h-3 w-3" />
          </button>
        )}
        <div className="relative" ref={pickerRef}>
          <button
            className={`flex items-center gap-1 rounded-sm p-1 text-ink-faint hover:text-ink ${pickerOpen ? 'text-ink' : ''}`}
            title={`Composer docked ${DOCK_LABEL[dock.side].toLowerCase()} ${ALIGN_LABEL[dock.align]}. Click to move it.`}
            aria-label="Move the composer"
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((o) => !o)}
          >
            <LayoutIcon className="h-3.5 w-3.5" />
          </button>
          {pickerOpen && (
            <div className="card absolute right-0 top-8 z-40 p-2.5 shadow-lg" style={{ background: 'var(--paper)' }} role="dialog" aria-label="Where the composer sits">
              <p className="mb-1.5 px-0.5 text-[11px] text-ink-faint">Where should the composer sit?</p>
              <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(3, 44px)' }} role="grid">
                {SIDES.map((side) => ALIGNS.map((align) => {
                  const on = dock.side === side && dock.align === align;
                  return (
                    <button
                      key={`${side}-${align}`}
                      role="gridcell"
                      aria-label={`${DOCK_LABEL[side]} ${ALIGN_LABEL[align]}`}
                      aria-selected={on}
                      className="relative h-[30px] rounded-md border transition-colors"
                      style={{ borderColor: on ? 'var(--accent)' : 'var(--line)', background: on ? 'var(--accent-soft)' : 'var(--surface-2)' }}
                      onClick={() => { onDock({ side, align }); setPickerOpen(false); }}
                      title={`${DOCK_LABEL[side]} ${ALIGN_LABEL[align]}`}
                    >
                      {/* A little bar where the composer would be in that cell. */}
                      <span
                        className="absolute h-[5px] w-[22px] rounded-sm"
                        style={{
                          background: on ? 'var(--accent)' : 'var(--ink-faint)',
                          top: side === 'top' ? 5 : undefined,
                          bottom: side === 'bottom' ? 5 : undefined,
                          left: align === 'left' ? 5 : align === 'center' ? '50%' : undefined,
                          right: align === 'right' ? 5 : undefined,
                          transform: align === 'center' ? 'translateX(-50%)' : undefined,
                        }}
                      />
                    </button>
                  );
                }))}
              </div>
            </div>
          )}
        </div>
      </div>
      {agent ? (
        <div className="min-h-0">
          <ChatPane key={agent.session.id} sessionId={agent.session.id} commandCenter surface="composer" />
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 px-4 py-4 text-[12.5px] text-ink-faint">
          <span>Click an agent window to talk to it here, or start one.</span>
          <button className="btn btn-primary py-1 text-[12px]" onClick={onNewAgent}><ChatIcon className="h-3.5 w-3.5" /> New agent</button>
          {agents.length > 0 && (
            <span className="flex flex-wrap gap-1">
              {agents.map((a) => (
                <button key={a.session.id} className="chip chip-action text-[11px]" onClick={() => onSelect(a.session.id)}><span className="wall-num">{a.n}</span>{a.session.title}</button>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The line that says which window the composer is speaking for: from the
 * composer's edge to the window's nearest edge, in the accent, faint, with a
 * dot where it lands. Drawn over the stage and never in the way of a click.
 */
export function WallTether({ stageRef, from, toSelector, deps }: { stageRef: React.RefObject<HTMLElement | null>; from: React.RefObject<HTMLElement | null>; toSelector: string | null; deps: unknown[] }) {
  const [path, setPath] = useState<{ d: string; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const a = from.current;
    const b = toSelector ? stage?.querySelector<HTMLElement>(toSelector) ?? null : null;
    if (!stage || !a || !b) { setPath(null); return; }
    let raf = 0;
    const compute = () => {
      const s = stage.getBoundingClientRect();
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      // The composer is above or below the wall; the tether leaves its nearest
      // horizontal edge at the x closest to the window's centre.
      const below = ra.top >= rb.bottom - 1;
      const above = ra.bottom <= rb.top + 1;
      if (!below && !above) { setPath(null); return; }
      // It lands on the wall's edge under (or over) the window, not on the
      // window itself: a line drawn across the windows in between would cut
      // through their text. The window's own ring carries the rest of the way.
      const wallEdge = stage.querySelector<HTMLElement>('[data-command-wall]')?.getBoundingClientRect();
      const cx = Math.min(Math.max(rb.left + rb.width / 2, ra.left + 24), ra.right - 24);
      const x1 = cx - s.left;
      const y1 = (below ? ra.top : ra.bottom) - s.top;
      const x2 = rb.left + rb.width / 2 - s.left;
      const edgeY = wallEdge ? (below ? wallEdge.bottom : wallEdge.top) : (below ? rb.bottom : rb.top);
      const y2 = edgeY - s.top;
      const mid = (y1 + y2) / 2;
      setPath({ d: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`, x: x2, y: y2 });
    };
    compute();
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(compute); });
    ro.observe(stage); ro.observe(a); ro.observe(b);
    window.addEventListener('resize', compute);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); window.removeEventListener('resize', compute); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef, from, toSelector, ...deps]);
  if (!path) return null;
  return (
    <svg className="wall-tether pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible" aria-hidden>
      <path d={path.d} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeOpacity="0.55" />
      <circle cx={path.x} cy={path.y} r="3.5" fill="var(--accent)" fillOpacity="0.9" />
    </svg>
  );
}
