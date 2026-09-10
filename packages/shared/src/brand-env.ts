/**
 * Reading environment variables across the names this app has shipped under.
 *
 * The product has been renamed three times (Open Paw → Nekkos → Kotrain →
 * Agent Nekko) and each rename would otherwise silently ignore a working
 * config: a `KOTRAIN_TOKEN` in someone's shell profile, or a deployed relay
 * whose Fly secrets predate the rename. So every lookup reads the current name
 * first and then each older one, newest to oldest, and nothing has to be
 * renamed in lockstep with an upgrade.
 *
 * Prefixes are ordered newest first. `NEKKO_` is what the docs and help text
 * advertise; the rest exist only to keep old configs working.
 */
export const ENV_PREFIXES = ['NEKKO_', 'KOTRAIN_', 'NEKKOS_', 'OPENPAW_'] as const;

/** The canonical prefix, for building the names shown in help text and errors. */
export const ENV_PREFIX = ENV_PREFIXES[0];

/**
 * The value of `NEKKO_<name>`, falling back to the same suffix under each
 * older brand prefix. An empty string counts as set (it is how a caller turns
 * a default off), so this checks presence rather than truthiness.
 *
 * `process` is reached through `globalThis` rather than referenced directly:
 * this package is also imported by the renderer, which is typed without node
 * and where `process` may genuinely not exist.
 */
export function brandEnv(name: string, env?: Record<string, string | undefined>): string | undefined {
  const source =
    env ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
    {};
  for (const prefix of ENV_PREFIXES) {
    const value = source[`${prefix}${name}`];
    if (value !== undefined) return value;
  }
  return undefined;
}
