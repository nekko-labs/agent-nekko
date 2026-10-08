import React, { useEffect, useRef } from 'react';
import { TerminalPane } from './TerminalPane.js';
import { CloseIcon, ExternalIcon, TerminalIcon } from '../icons.js';

/**
 * An agent's command log, bubbled out of the middle of its window's right
 * edge. On the Agents wall the Logs button used to open a terminal pane in the
 * Chat view, which is hidden unless the developer Chat surface is switched on:
 * the button animated and nothing appeared. The log now opens right where the
 * agent is, over its own window, and grows out of the point it is anchored to.
 */
export function AgentLogsBubble({ sessionId, title, onClose, onPopOut }: {
  sessionId: string;
  title: string;
  onClose: () => void;
  /** Open the log as its own window in the Chat view, when that view exists. */
  onPopOut?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest('[aria-label="Open agent logs"]')) onClose();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown); };
  }, [onClose]);
  return (
    <div ref={ref} className="agent-logs-bubble" role="dialog" aria-label={`Command log for ${title}`} data-agent-logs>
      <header className="agent-logs-bubble-head">
        <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate">Agent commands</span>
        {onPopOut && <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Open the log as its own window" aria-label="Open the log as its own window" onClick={onPopOut}><ExternalIcon className="h-3 w-3" /></button>}
        <button type="button" className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Close the log (Esc)" aria-label="Close the command log" onClick={onClose}><CloseIcon className="h-3 w-3" /></button>
      </header>
      <div className="agent-logs-bubble-body"><TerminalPane terminalId={`agent_${sessionId}`} /></div>
    </div>
  );
}
