import { afterEach, describe, expect, it, vi } from 'vitest';
import { celebrateCompletion, COMPLETION_ANIMATION_MS } from './completionCelebration.js';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('completion celebration', () => {
  it('skips the effect for reduced motion', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    celebrateCompletion({ left: 10, top: 20, width: 12, height: 12 });
  });

  it('anchors the check and six particles to the control, then removes them at 800 ms', () => {
    vi.useFakeTimers();
    const makeElement = () => ({ className: '', style: { left: '', top: '', setProperty: vi.fn() }, innerHTML: '', setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn() });
    const effect = makeElement();
    const createElement = vi.fn().mockReturnValueOnce(effect).mockImplementation(makeElement);
    const append = vi.fn();
    vi.stubGlobal('document', { createElement, body: { append } });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), setTimeout });
    celebrateCompletion({ left: 10, top: 20, width: 12, height: 12 });
    expect(effect.style.left).toBe('16px');
    expect(effect.style.top).toBe('26px');
    expect(effect.innerHTML).toContain('completion-check');
    expect(effect.innerHTML).toContain('completion-circle');
    expect(effect.append).toHaveBeenCalledTimes(6);
    expect(append).toHaveBeenCalledWith(effect);
    vi.advanceTimersByTime(COMPLETION_ANIMATION_MS - 1);
    expect(effect.remove).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(effect.remove).toHaveBeenCalledOnce();
    expect(COMPLETION_ANIMATION_MS).toBeLessThanOrEqual(800);
  });
});
