import { expect, it } from 'vitest';
import { INSTALL } from './lib/probes.mjs';

it('finds transcript-only panels without requiring an embedded composer', async () => {
  const scroller = { checkVisibility: () => true, getBoundingClientRect: () => ({ top: 100, bottom: 200 }) };
  const reply = { textContent: '[newest]', getBoundingClientRect: () => ({ top: 120, bottom: 180, height: 60 }), closest: () => scroller };
  const panel = { checkVisibility: () => true, firstElementChild: { querySelector: () => ({ textContent: 'Chat' }) }, querySelector: () => scroller, querySelectorAll: () => [reply] };
  const document = { querySelectorAll: (selector: string) => selector === '.panel' ? [panel] : [], addEventListener: () => {} };
  const window: any = {};
  new Function('window', 'document', 'requestAnimationFrame', 'PerformanceObserver', 'performance', INSTALL)(window, document, (fn: Function) => fn(), class { observe() {} }, { now: () => 0 });
  expect(await window.__perf.waitForChat('Chat', '[newest]')).toBe(true);
});
