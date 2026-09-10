/**
 * Reading the browser-storage keys this app has used under earlier brands.
 *
 * Keys are namespaced by product name, so renaming one silently throws away
 * whatever the user had there: an unsent composer draft, a dock they left open,
 * a pane height. The value is read from the current key, then from each older
 * brand, and rewritten under the current one so the lookup only happens once.
 */
const LEGACY_PREFIXES = ['kotrain', 'nekkos', 'open-paw'];

/** `nekko.foo` plus the same suffix under each earlier brand, newest first. */
export function brandKeys(key: string): string[] {
  const suffix = key.replace(/^nekko([._])/, '$1');
  return [key, ...LEGACY_PREFIXES.map((prefix) => `${prefix}${suffix}`)];
}

/**
 * The value at `key`, adopting an earlier brand's value if that is the only one
 * present. Storage can throw (Safari private mode, a blocked origin), so every
 * access is guarded and a failure just reads as absent.
 */
export function readBrandKey(store: Pick<Storage, 'getItem' | 'setItem'>, key: string): string | null {
  for (const candidate of brandKeys(key)) {
    let value: string | null = null;
    try {
      value = store.getItem(candidate);
    } catch {
      return null;
    }
    if (value === null) continue;
    if (candidate !== key) {
      // Adopt it, but leave the original in place so a downgrade still finds it.
      try {
        store.setItem(key, value);
      } catch {
        /* full or blocked: the value was still read */
      }
    }
    return value;
  }
  return null;
}
