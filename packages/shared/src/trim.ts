/**
 * Drop trailing `/` (and, with `backslash`, `\`) from a string, in one pass.
 *
 * The obvious `s.replace(/\/+$/, '')` is quadratic on a string made of many
 * slashes not at the end (the engine retries the `+` from every start
 * position), and these run on paths and URLs that come from config files and
 * other programs. A backwards scan is linear whatever the input.
 */
export function trimTrailingSlashes(s: string, backslash = false): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c === 47 /* / */ || (backslash && c === 92) /* \ */) end -= 1;
    else break;
  }
  return end === s.length ? s : s.slice(0, end);
}
