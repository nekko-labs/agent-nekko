import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('wall edge stability and composer handles', () => {
  it('excludes dormant Add cards from scroll geometry and reserves the scrollbar gutter', () => {
    const css = readFileSync(new URL('./commandWallLayouts.css', import.meta.url), 'utf8');
    expect(css).toContain('scrollbar-gutter: stable');
    expect(css).toContain('overflow-x: hidden');
    expect(css).toContain('.command-wall-add:not([data-preview]) { display: none;');
    expect(css).toContain('.command-wall-add-rail-bottom > span { transform: translateY(-3px)');
  });
  it('keeps all resize handles on the composer and supports cancellation and reset', () => {
    const source = readFileSync(new URL('./WallComposer.tsx', import.meta.url), 'utf8');
    expect(source).toContain('{resizeHandle}');
    expect(source).toContain("(['left', 'right'] as const).map");
    expect(source).toContain('setPointerCapture(e.pointerId)');
    expect(source).toContain('onLostPointerCapture');
    expect(source).toContain("dock.align === 'center' ? 2 : 1");
    expect(source).toContain('onDoubleClick={() => setWidth(null)}');
    expect(source).toContain("e.key === 'Home'");
    expect(source).toContain('Math.min(available, next)');
  });
});
