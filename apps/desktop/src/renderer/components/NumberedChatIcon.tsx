import React from 'react';
import { ChatIcon } from '../icons.js';

/** One window identity: its keyboard number inside the chat outline. */
export function NumberedChatIcon({ number }: { number?: number }) {
  return <span className="numbered-chat-icon" title={number == null ? 'Chat' : `Window ${number}${number <= 9 ? `: Ctrl+${number} selects it` : ''}`}>
    <ChatIcon className="h-6 w-6" />
    {number != null && <span aria-label={`Window ${number}`}>{number}</span>}
  </span>;
}

/**
 * An agent window's identity on the wall: a robot head (antenna and ear
 * nubs) whose face is the window's keyboard number, so "which agent" and
 * "which key selects it" read as one mark.
 */
export function NumberedAgentIcon({ number }: { number?: number }) {
  return <span className="numbered-agent-icon" title={number == null ? 'Agent' : `Agent window ${number}${number <= 9 ? `: Ctrl+${number} selects it` : ''}`}>
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5v3" />
      <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none" />
      <rect x="4" y="6.5" width="16" height="14" rx="4" />
      <path d="M2 12.5v3M22 12.5v3" />
    </svg>
    {number != null ? <span aria-label={`Window ${number}`}>{number}</span> : <span aria-hidden="true">·</span>}
  </span>;
}
