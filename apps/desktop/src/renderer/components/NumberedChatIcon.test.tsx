import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NumberedChatIcon } from './NumberedChatIcon.js';
describe('numbered chat identity', () => {
  it('puts the window number inside the enlarged icon, without a separate badge', () => {
    const html = renderToStaticMarkup(<NumberedChatIcon number={2} />);
    expect(html).toContain('h-6 w-6');
    expect(html).toContain('aria-label="Window 2"');
    expect(html).toContain('Ctrl+2 selects it');
    expect(html).not.toContain('wall-num');
  });
  it('keeps larger numbers readable without advertising unavailable shortcuts', () => {
    const html = renderToStaticMarkup(<NumberedChatIcon number={12} />);
    expect(html).toContain('Window 12');
    expect(html).not.toContain('Ctrl+12');
  });
});
