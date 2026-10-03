import { useSyncExternalStore } from 'react';

/** A minimal observable store: services own the state, screens subscribe. */
export interface Store<T> {
  get(): T;
  set(next: Partial<T> | ((prev: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const patch = typeof next === 'function' ? next(state) : next;
      state = { ...state, ...patch };
      for (const l of listeners) l();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Subscribe a component to a slice. Return a stable value (a field, not a new object). */
export function useStore<T extends object, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}
