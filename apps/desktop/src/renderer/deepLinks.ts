/**
 * Parsing the `agent-nekko://` URLs other apps use to reach this one.
 *
 * Kept apart from the component that acts on them because this is the security
 * boundary: the URL is the only part of the exchange another program controls,
 * so it is turned into a small, checked value here, and everything downstream
 * (which daemon, whose tools, what version) is read back from the daemon
 * itself. Pure, and unit-tested accordingly.
 */

/** The port Hypergate's daemon uses unless it was told otherwise. */
export const DEFAULT_HYPERGATE_PORT = 7777;

/**
 * Schemes that reach this app: the current one first, then every brand it has
 * shipped under. A Hypergate built against an older name still emits
 * `kotrain://`, and that install is not going to be upgraded in lockstep with
 * this one, so the older schemes stay accepted rather than silently failing.
 */
export const LINK_SCHEMES = ['agent-nekko', 'kotrain', 'nekkos'] as const;

/**
 * The port in an `agent-nekko://hypergate/connect` link, or null if the URL is
 * not one. A link with no `port` means the default, which is what Hypergate
 * emits when it is running where it always runs. Legacy brand schemes are
 * accepted too, see `LINK_SCHEMES`.
 */
export function hypergateConnectPort(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.some((scheme) => parsed.protocol === `${scheme}:`)) return null;
  // `agent-nekko://hypergate/connect` parses with "hypergate" as the host.
  if (parsed.host !== 'hypergate' || parsed.pathname.replace(/\/+$/, '') !== '/connect') return null;
  const raw = parsed.searchParams.get('port');
  if (raw === null) return DEFAULT_HYPERGATE_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}
