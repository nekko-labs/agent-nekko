import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../i18n.js', () => ({ useT: () => (key: string) => key }));
vi.mock('@nekko-agent/shared', () => import('../../../../../packages/shared/src/themes.js'));
import { slicedSwatch, ThemePresetPicker } from './ThemePresetPicker.js';
import type { AppSettings } from '@nekko-agent/shared';

describe('theme palette slices', () => {
  it('uses adjacent hard stops rather than blending colors', () => {
    expect(slicedSwatch(['#111', '#222', '#333', '#444'])).toBe('conic-gradient(from 0deg, #111 0% 25%, #222 25% 50%, #333 50% 75%, #444 75% 100%)');
  });
  it('places Spooky once in the final Fun! preset group', () => {
    const markup = renderToStaticMarkup(<ThemePresetPicker settings={{ theme: 'dark', accent: '#6d5efc' } as AppSettings} update={() => {}} />);
    expect(markup).toContain('aria-label="Fun!"');
    expect(markup.match(/title="Spooky"/g)).toHaveLength(1);
    expect(markup).not.toContain('title="Autumn"');
    expect(markup.indexOf('aria-label="Fun!"')).toBeGreaterThan(markup.indexOf('settings.themeDark'));
  });
  it('renders preset and custom circles with solid slices', () => {
    const markup = renderToStaticMarkup(<ThemePresetPicker settings={{ theme: 'dark', accent: '#6d5efc' } as AppSettings} update={() => {}} />);
    expect(markup).toContain('conic-gradient');
    expect(markup).toContain('#f87171 0% 16.666666666666668%');
    expect(markup).toContain('role="radiogroup"');
  });
});
