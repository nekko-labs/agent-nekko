/**
 * Pairing links. The desktop's Settings → Remote access shows a QR that
 * carries `nekko-agent-pair:?relay=&room=&key=&pair=` (or, from the web
 * edition, `https://host/?relay=…`). Either form, or a bare query string,
 * parses to the same credentials.
 */
export interface PairingLink {
  relayUrl: string;
  room: string;
  key: string;
  /** One-time enrollment code; absent when re-using an existing pairing. */
  pair?: string;
}

export function parsePairingLink(input: string): PairingLink | null {
  const raw = input.trim();
  if (!raw) return null;
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : raw;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(q.split('#')[0]);
  } catch {
    return null;
  }
  const relayUrl = params.get('relay')?.trim();
  const room = params.get('room')?.trim();
  const key = params.get('key')?.trim();
  if (!relayUrl || !room || !key) return null;
  if (!/^wss?:\/\//i.test(relayUrl)) return null;
  // Room is 16 hex chars and the secret 32; accept anything hex-shaped so a
  // future longer secret still pairs, but refuse obvious garbage.
  if (!/^[0-9a-f]{8,128}$/i.test(room) || !/^[0-9a-f]{16,256}$/i.test(key)) return null;
  const pair = params.get('pair')?.trim().toUpperCase() || undefined;
  return { relayUrl: relayUrl.replace(/\/+$/, ''), room, key, pair };
}

/** Relay host for display ("nekko-agent-relay.fly.dev"). */
export function relayHost(relayUrl: string): string {
  return relayUrl.replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
}
