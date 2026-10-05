import React from 'react';
import { ChatIcon } from '../icons.js';

/** One window identity: its keyboard number inside the chat outline. */
export function NumberedChatIcon({ number }: { number?: number }) {
  return <span className="numbered-chat-icon" title={number == null ? 'Chat' : `Window ${number}${number <= 9 ? `: Ctrl+${number} selects it` : ''}`}>
    <ChatIcon className="h-6 w-6" />
    {number != null && <span aria-label={`Window ${number}`}>{number}</span>}
  </span>;
}
