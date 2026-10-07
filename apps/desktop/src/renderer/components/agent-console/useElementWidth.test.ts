import { beforeEach, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)>, setWidth: vi.fn() }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [typeof initial === 'function' ? initial() : initial, hooks.setWidth],
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));

let deliver: ResizeObserverCallback;
const disconnect = vi.fn();
const observe = vi.fn();
beforeEach(() => {
  vi.resetModules();
  hooks.effects = [];
  hooks.setWidth.mockClear();
  disconnect.mockClear();
  observe.mockClear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { deliver = callback; }
    observe = observe;
    disconnect = disconnect;
  });
});

it('uses delivered widths without DOM reads, retaining cold bootstrap and hidden-pane cache', async () => {
  const { useElementWidth } = await import('./useElementWidth.js');
  const read = vi.fn(() => 800);
  const el = { get clientWidth() { return read(); } } as HTMLElement;
  const ref = { current: el };
  expect(useElementWidth(ref, 'chat')).toBe(0);
  const cleanup = hooks.effects.pop()!();
  expect(read).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0][0]).toBe(el);
  expect(hooks.setWidth).toHaveBeenLastCalledWith(800);

  // A DOM width read during delivery would force layout (or fail this test).
  read.mockImplementation(() => { throw new Error('unexpected layout read'); });
  const resize = (target: HTMLElement, width: number) => deliver([
    { target, contentRect: { width } } as ResizeObserverEntry,
  ], {} as ResizeObserver);
  resize(el, 640.4);
  expect(hooks.setWidth).toHaveBeenLastCalledWith(640);
  const calls = hooks.setWidth.mock.calls.length;
  resize(el, 0);
  resize({} as HTMLElement, 123);
  expect(hooks.setWidth).toHaveBeenCalledTimes(calls);
  expect(useElementWidth(ref, 'chat')).toBe(640);
  expect(useElementWidth(ref, 'other-chat')).toBe(640);
  hooks.effects.pop()!();
  expect(read).toHaveBeenCalledTimes(1); // warm mount needs no synchronous measurement
  expect(cleanup).toBeTypeOf('function');
  if (typeof cleanup === 'function') cleanup();
  expect(disconnect).toHaveBeenCalledTimes(1);
});
