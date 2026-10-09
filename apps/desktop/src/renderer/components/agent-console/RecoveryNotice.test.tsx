import React from 'react';
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage } from '@nekko-agent/shared';
import { isRecoveryNotice, RecoveryNotice } from './RecoveryNotice.js';

const message: ChatMessage = { id: 'restart', role: 'assistant', interrupted: true, createdAt: 1, content: '_The app closed while this reply was running._\n\n_This reply was cut off before it finished. Everything above is kept, resume to carry on from here._' };

it('recognizes persisted restart notices without treating real replies as notices', () => {
  expect(isRecoveryNotice(message)).toBe(true);
  expect(isRecoveryNotice({ ...message, content: `Work done\n\n${message.content}` })).toBe(false);
  expect(isRecoveryNotice({ ...message, interrupted: false })).toBe(false);
  expect(isRecoveryNotice({ ...message, role: 'user' })).toBe(false);
  expect(isRecoveryNotice({ ...message, reasoning: 'Thinking' })).toBe(false);
});

it('presents recovery as a subtle informational card rather than model Markdown', () => {
  const html = renderToStaticMarkup(<RecoveryNotice />);
  expect(html).toContain('role="note"');
  expect(html).toContain('Reply interrupted');
  expect(html).toContain('Everything above is saved; Continue picks up from here.');
  expect(html).not.toContain('msg-ai');
  expect(html).not.toContain('<em>');
});
