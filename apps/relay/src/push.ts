import http2 from 'node:http2';
import { createPrivateKey, sign as cryptoSign, createSign, type KeyObject } from 'node:crypto';

/**
 * Relay-side push sender. The relay is the one always-on piece, so it holds the
 * push credentials (server secrets) and sends a **content-free** notification to
 * a paired phone when its desktop signals a finished run while the phone is
 * offline. The relay never sees the (E2E-encrypted) conversation, only the
 * "a run finished" signal, so a generic body keeps the zero-knowledge property.
 *
 * APNs is implemented natively (HTTP/2 + ES256 JWT, no dependency). FCM is a
 * documented stub until a Google service account is configured.
 */

export interface PushPayload {
  title: string;
  body: string;
}

export interface PushSender {
  enabled: boolean;
  send(token: string, platform: 'ios' | 'android', payload: PushPayload): Promise<void>;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * Build an APNs provider JWT (ES256), cached for ~50 min as Apple recommends.
 * Exported for unit testing. `nowSec` is injectable for deterministic tests.
 */
export function makeApnsJwt(opts: { keyP8: string; keyId: string; teamId: string }) {
  const key: KeyObject = createPrivateKey(opts.keyP8);
  let cached = '';
  let cachedAt = 0;
  return (nowSec: number = Math.floor(Date.now() / 1000)): string => {
    if (cached && nowSec - cachedAt < 3000) return cached;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: opts.keyId }));
    const payload = b64url(JSON.stringify({ iss: opts.teamId, iat: nowSec }));
    const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
    cached = `${header}.${payload}.${b64url(sig)}`;
    cachedAt = nowSec;
    return cached;
  };
}

async function sendApns(
  host: string,
  jwt: string,
  bundleId: string,
  token: string,
  payload: PushPayload,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);
    client.on('error', reject);
    const body = JSON.stringify({ aps: { alert: { title: payload.title, body: payload.body }, sound: 'default' } });
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': bundleId,
      'apns-push-type': 'alert',
      'content-type': 'application/json',
    });
    let status = 0;
    req.on('response', (h) => (status = Number(h[':status'])));
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      client.close();
      status >= 200 && status < 300 ? resolve() : reject(new Error(`APNs ${status}: ${data}`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/**
 * Build a Google OAuth2 JWT assertion (RS256) for the FCM messaging scope.
 * Exported for unit testing; `nowSec` injectable.
 */
export function makeFcmAssertion(sa: ServiceAccount, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key);
  return `${header}.${claims}.${b64url(sig)}`;
}

/** Exchange the assertion for an access token (cached ~55 min). */
function fcmTokenProvider(sa: ServiceAccount) {
  let token = '';
  let exp = 0;
  return async (): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    if (token && now < exp - 60) return token;
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeFcmAssertion(sa, now),
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`FCM token ${res.status}: ${await res.text()}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    token = j.access_token;
    exp = now + (j.expires_in ?? 3600);
    return token;
  };
}

async function sendFcm(projectId: string, accessToken: string, token: string, payload: PushPayload): Promise<void> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title: payload.title, body: payload.body } } }),
  });
  if (!res.ok) throw new Error(`FCM ${res.status}: ${await res.text()}`);
}

function parseServiceAccount(raw?: string): ServiceAccount | null {
  if (!raw) return null;
  try {
    const sa = JSON.parse(raw);
    return sa.client_email && sa.private_key && sa.project_id ? sa : null;
  } catch {
    return null;
  }
}

export function createPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  const keyP8 = env.APNS_KEY_P8;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const bundleId = env.APNS_BUNDLE_ID ?? 'dev.nekkolabs.agentnekko';
  const apnsHost = env.APNS_PRODUCTION === '1' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const apnsReady = !!(keyP8 && keyId && teamId);
  const apnsJwt = apnsReady ? makeApnsJwt({ keyP8: keyP8!, keyId: keyId!, teamId: teamId! }) : null;

  const serviceAccount = parseServiceAccount(env.FCM_SERVICE_ACCOUNT);
  const fcmReady = !!serviceAccount;
  const fcmToken = serviceAccount ? fcmTokenProvider(serviceAccount) : null;

  return {
    enabled: apnsReady || fcmReady,
    async send(token, platform, payload) {
      try {
        if (platform === 'ios') {
          if (!apnsJwt) return void console.log('[push] APNs not configured (set APNS_KEY_P8/APNS_KEY_ID/APNS_TEAM_ID)');
          await sendApns(apnsHost, apnsJwt(), bundleId, token, payload);
          console.log('[push] APNs sent');
        } else {
          if (!fcmToken || !serviceAccount) return void console.log('[push] FCM not configured (set FCM_SERVICE_ACCOUNT)');
          await sendFcm(serviceAccount.project_id, await fcmToken(), token, payload);
          console.log('[push] FCM sent');
        }
      } catch (e) {
        console.warn(`[push] send failed: ${(e as Error).message}`);
      }
    },
  };
}
