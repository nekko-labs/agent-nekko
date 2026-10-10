import { parsePairingLink } from '@/lib/pairing';

/**
 * Scanning the desktop's pairing QR with the system camera opens
 * `nekko-agent-pair:?relay=…`. That URL has no path for the router, so turn
 * it into the pairing screen with the link attached.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    if (/^nekko-agent-pair:/i.test(path) || parsePairingLink(path)) {
      return `/pair?link=${encodeURIComponent(path)}`;
    }
  } catch {
    /* fall through to normal routing */
  }
  return path;
}
