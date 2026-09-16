/**
 * Reading the browser-storage keys this app uses.
 *
 * Keys are namespaced `nekko.*`. Storage can throw (Safari private mode, a
 * blocked origin), so every access is guarded and a failure just reads as
 * absent.
 */

/** The storage keys for `key`: today just the key itself. */
export function brandKeys(key: string): string[] {
  return [key];
}

/** The value at `key`, or null when absent/unreadable. */
export function readBrandKey(store: Pick<Storage, 'getItem' | 'setItem'>, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
