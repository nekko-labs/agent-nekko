import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../Markdown.js', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }));
vi.mock('./rowState.js', () => ({ useRowState: (_key: string, value: unknown) => [value, vi.fn()] }));
vi.mock('./ToolCard.js', () => ({ ToolCard: () => <div>Tool</div> }));
import { MessageBubble } from './MessageBubble.js';

describe('message actions and completion', () => {
  const message = { id: 'saved', role: 'assistant' as const, content: 'Finished reply', createdAt: 1 };
  it.each([false, true])('adds an icon to Copy and removes To composer (chronological=%s)', (chronological) => {
    const html = renderToStaticMarkup(<MessageBubble message={message} chronological={chronological} onCopyToComposer={vi.fn()} />);
    expect(html).toContain('Copy');
    expect(html).toContain('<svg');
    expect(html).not.toContain('To composer');
    expect(html).toContain('Done.');
  });
  it.each([
    { ...message, id: 'live' },
    { ...message, interrupted: true },
    { ...message, toolCalls: [{ id: 'call', name: 'read_file', input: {} }] },
    { ...message, role: 'user' as const },
  ])('does not claim an unfinished or user message is done', (message) => {
    expect(renderToStaticMarkup(<MessageBubble message={message} />)).not.toContain('Done.');
  });
});
