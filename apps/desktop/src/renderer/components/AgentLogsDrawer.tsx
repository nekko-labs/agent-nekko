import React, { useEffect, useRef } from 'react';
import { TerminalPane } from './TerminalPane.js';
import { CloseIcon, ExternalIcon, TerminalIcon } from '../icons.js';
import { useStore } from '../store.js';
import { useWallLogs, type Rect } from '../wallLogs.js';

/**
 * An agent's command log on the Agents wall, as a drawer of its own that
 * slides out of its window's right edge. It used to float over the window and
 * cover the transcript; now the wall makes room for it (CommandWall moves the
 * windows to its right) and, closed, it is absorbed back into the window. Its
 * left side has no border and covers the window's edge, so the two read as one.
 */
export function AgentLogsDrawer({ sessionId, title, rect, overlay, selected }: {
  sessionId: string;
  title: string;
  rect: Rect;
  /** A one-column wall: the drawer sits over its window instead of beside it. */
  overlay?: boolean;
  selected?: boolean;
}) {
  const closing = useWallLogs((s) => s.closing);
  const close = useWallLogs((s) => s.close);
  const closed = useWallLogs((s) => s.closed);
  const chatViewOn = useStore((s) => s.settings?.developer?.chat === true);
  const ref = useRef<HTMLDivElement>(null);

  // Without motion there is no animationend to wait for.
  useEffect(() => {
    if (closing && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) closed();
  }, [closing, closed]);

  return (
    <div
      ref={ref}
      className="agent-logs-drawer"
      role="dialog"
      aria-label={`Command log for ${title}`}
      data-agent-logs
      data-closing={closing || undefined}
      data-selected={selected || undefined}
      data-overlay={overlay || undefined}
      style={overlay ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : { left: rect.x - 1, top: rect.y, width: rect.width + 1, height: rect.height }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}
      onAnimationEnd={(e) => { if (e.target === ref.current && closing) closed(); }}
    >
      <div className="agent-logs-drawer-inner">
        <header className="agent-logs-drawer-head">
          <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate">Agent commands</span>
          {chatViewOn && <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Open the log as its own window" aria-label="Open the log as its own window" onClick={() => { close(); useStore.getState().openTerminalPane(`agent_${sessionId}`); }}><ExternalIcon className="h-3 w-3" /></button>}
          <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Close the log (Esc)" aria-label="Close the command log" onClick={close}><CloseIcon className="h-3 w-3" /></button>
        </header>
        <div className="agent-logs-drawer-body"><TerminalPane terminalId={`agent_${sessionId}`} /></div>
      </div>
    </div>
  );
}
