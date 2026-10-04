import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: vi.fn() }));
import { Mascot, MiniNekko, NekkoAvatar } from './Mascot.js';
import { LANGUAGES, translate } from '../i18n.js';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Pixel Nekko', () => {
  it('is decorative by default and accessible when titled', () => {
    const decorative = renderToStaticMarkup(<NekkoAvatar />);
    expect(decorative).toContain('aria-hidden="true"');
    expect(decorative).toContain('role="presentation"');
    const labelled = renderToStaticMarkup(<NekkoAvatar title="Nekko" />);
    expect(labelled).toContain('aria-label="Nekko"');
    expect(labelled).toContain('role="img"');
    expect(labelled).not.toContain('aria-hidden');
  });

  it.each([16, 18, 24, 28, 40, 64])('keeps a square grid at %spx', (size) => {
    const markup = renderToStaticMarkup(<NekkoAvatar size={size} />);
    expect(markup).toContain(`width="${size}" height="${size}"`);
    expect(markup).toContain('viewBox="0 0 32 32"');
    expect(markup).toContain('shape-rendering="crispEdges"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('fill="#101714"');
    expect(markup).toContain('stroke="#f2f1e9"');
  });

  it('shares the head and all eye frames across desktop surfaces without spy accessories', () => {
    for (const markup of [renderToStaticMarkup(<NekkoAvatar />), renderToStaticMarkup(<MiniNekko />), renderToStaticMarkup(<Mascot mood="idle" enabled />)]) {
      expect(markup.match(/data-part="pixel-head"/g)).toHaveLength(1);
      for (const eye of ['open', 'happy', 'closed']) expect(markup).toContain(`pixel-eyes-${eye}`);
      expect(markup).not.toMatch(/sunglasses|earpiece|collar|tie|slender-body|filter=/);
    }
  });

  it('keeps working feedback, greeting, and the visibility setting', () => {
    expect(renderToStaticMarkup(<MiniNekko size={16} />)).toContain('pixel-working');
    const working = renderToStaticMarkup(<Mascot mood="thinking" enabled />);
    expect(working).toContain('data-mascot-pose="working"');
    expect(working).toContain('Nekko is working');
    expect(working).toContain('<button type="button"');
    expect(renderToStaticMarkup(<Mascot mood="waving" enabled />)).toContain('data-mascot-pose="happy"');
    expect(renderToStaticMarkup(<Mascot mood="idle" enabled={false} />)).toBe('');
  });

  it('uses matching head and eye geometry on marketing and mobile', () => {
    const desktop = source('./Mascot.tsx');
    const website = source('../../../../../apps/website/index.html');
    const mobile = source('../../../../../apps/mobile/src/ui/Mascot.tsx');
    const paths = [...desktop.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
    expect(paths).toHaveLength(5);
    for (const path of paths) {
      expect(website).toContain(path);
      expect(mobile).toContain(path);
    }
  });

  it('provides stepped motion and reduced-motion guards', () => {
    for (const css of [source('../styles.css'), source('../../../../../apps/website/styles.css')]) {
      expect(css).toContain('steps(1, end)');
      expect(css).toContain('@media (prefers-reduced-motion: reduce)');
      expect(css).toContain('.pixel-nekko, .pixel-nekko * { animation: none !important; }');
    }
    expect(source('./Mascot.tsx')).toContain("document.addEventListener('visibilitychange'");
    const mobile = source('../../../../../apps/mobile/src/ui/Mascot.tsx');
    expect(mobile).toContain('isReduceMotionEnabled');
    expect(mobile).toContain('clearInterval(timer)');
    expect(mobile).toContain("AppState.addEventListener('change'");
  });

  it('preserves translated mascot settings', () => {
    for (const { code } of LANGUAGES) expect(translate(code, 'settings.mascot')).toContain('Nekko');
  });
});
