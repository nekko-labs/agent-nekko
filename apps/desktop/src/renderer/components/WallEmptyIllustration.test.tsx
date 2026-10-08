import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const preset = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('../store.js', () => ({ useStore: (select: (s: unknown) => unknown) => select({ settings: { themePreset: preset.value } }) }));
import { WallEmptyIllustration, wallEmptyVariant } from './WallEmptyIllustration.js';

describe('empty wall illustration', () => {
  it('maps only the Spooky (autumn) preset to the spooky variant', () => {
    expect(wallEmptyVariant('autumn')).toBe('spooky');
    for (const p of [undefined, 'dark', 'light', 'nebula', 'terminal']) expect(wallEmptyVariant(p)).toBe('default');
  });
  it('dresses the scene for Spooky and keeps it plain otherwise', () => {
    preset.value = 'dark';
    const plain = renderToStaticMarkup(<WallEmptyIllustration />);
    expect(plain).toContain('data-variant="default"');
    expect(plain).not.toContain('data-part="spooky"');
    expect(plain).not.toContain('orange-wizard-hat');
    expect(plain).toContain('aria-hidden="true"');
    preset.value = 'autumn';
    const spooky = renderToStaticMarkup(<WallEmptyIllustration />);
    expect(spooky).toContain('data-variant="spooky"');
    expect(spooky).toContain('data-part="spooky"');
    expect(spooky).toContain('orange-wizard-hat');
  });
});
