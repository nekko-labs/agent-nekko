import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { OAuthProvider, OAuthSessionInfo, OAuthStatus, OAuthTokenSet, ProviderConfig } from '@agent-nekko/shared';
import { dataDir } from './paths.js';
import { ensurePrivateFile, writeJsonAtomic } from './secure-file.js';

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const CLAUDE_SCOPES = 'org:create_api_key user:profile user:inference';
const CLAUDE_MANUAL_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const CLAUDE_LOOPBACK_PORT_START = 8765;
const CLAUDE_LOOPBACK_PORT_END = 8795;

/** Bind failures that mean "this port is not ours to take", not a fatal error. */
const UNAVAILABLE_PORT_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);

const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CHATGPT_SCOPES = 'openid profile email offline_access';
const CHATGPT_REDIRECT_URI = 'http://localhost:1455/auth/callback';

/** Milliseconds a pending OAuth session stays valid. */
const SESSION_TTL_MS = 10 * 60 * 1000;

/** ChatGPT CLI access tokens are valid for 10 days after `last_refresh`. */
const CHATGPT_CLI_TOKEN_TTL_MS = 10 * 24 * 60 * 60 * 1000;

/** In-memory pending sessions keyed by session id. */
interface OAuthSession {
  id: string;
  provider: OAuthProvider;
  verifier: string;
  state: string;
  challenge: string;
  redirectUri: string;
  mode: 'loopback' | 'manual';
  expiresAt: number;
  server?: ReturnType<typeof createServer>;
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, OAuthSession>();
const inFlight = new Map<string, Promise<string>>();
let events: EventEmitter | null = null;

/** Wire the OAuth service to the host's event bus. Called once in createHost. */
export function initOAuth(eventBus: EventEmitter): void {
  events = eventBus;
}

function tokenStorePath(): string {
  return join(dataDir(), 'tokens.json');
}

function loadTokens(): Record<string, OAuthTokenSet> {
  const p = tokenStorePath();
  if (!existsSync(p)) return {};
  ensurePrivateFile(p);
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, OAuthTokenSet>;
  } catch {
    return {};
  }
}

function saveTokens(tokens: Record<string, OAuthTokenSet>): void {
  writeJsonAtomic(tokenStorePath(), tokens);
}

export function getToken(tokenKey: string): OAuthTokenSet | undefined {
  return loadTokens()[tokenKey];
}

export function setToken(tokenKey: string, tokenSet: OAuthTokenSet): void {
  const tokens = loadTokens();
  tokens[tokenKey] = tokenSet;
  saveTokens(tokens);
}

export function deleteToken(tokenKey: string): void {
  const tokens = loadTokens();
  delete tokens[tokenKey];
  saveTokens(tokens);
}

/** Build a sanitized status object. Never includes the access token. */
function buildStatus(
  tokenKey: string,
  tokenSet?: OAuthTokenSet,
  state: OAuthStatus['state'] = 'success',
  message?: string,
): OAuthStatus {
  if (!tokenSet) {
    return { tokenKey, connected: false, state: state ?? 'missing', message };
  }
  const expiresAt = tokenExpiresAt(tokenSet);
  const expired = !!expiresAt && expiresAt < Date.now();
  return {
    tokenKey,
    provider: tokenSet.provider,
    connected: !expired,
    accountId: tokenSet.accountId,
    expiresAt: tokenSet.expiresAt,
    scopes: tokenSet.scopes,
    state,
    message,
  };
}

function emitStatus(status: OAuthStatus): void {
  events?.emit('oauthStatus', status);
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(16).toString('base64url');
}

function buildAuthorizeUrl(
  provider: OAuthProvider,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL(provider === 'claude' ? CLAUDE_AUTHORIZE_URL : CHATGPT_AUTHORIZE_URL);
  // Claude's console callback only renders the `code#state` string to copy when
  // `code=true` is set; without it the page has nothing for the manual fallback
  // to paste. Loopback redirects must not set it, or the browser lands on that
  // page instead of coming back to us.
  if (provider === 'claude' && redirectUri === CLAUDE_MANUAL_REDIRECT_URI) {
    url.searchParams.set('code', 'true');
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider === 'claude' ? CLAUDE_CLIENT_ID : CHATGPT_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', provider === 'claude' ? CLAUDE_SCOPES : CHATGPT_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

function listenOnce(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function findClaudeLoopbackPort(
  session: OAuthSession,
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<number | undefined> {
  for (let port = CLAUDE_LOOPBACK_PORT_START; port <= CLAUDE_LOOPBACK_PORT_END; port++) {
    const server = createServer(handler);
    session.server = server;
    try {
      await listenOnce(server, port);
      return port;
    } catch (e: any) {
      try {
        server.close();
      } catch {
        /* best effort */
      }
      // A port can be unavailable without being in use: Windows reserves
      // ranges for Hyper-V/WinNAT and refuses the bind with EACCES. Those are
      // "try the next one" too, not a reason to fail the whole sign-in.
      if (!UNAVAILABLE_PORT_CODES.has(e?.code)) {
        session.server = undefined;
        throw e;
      }
    }
  }
  session.server = undefined;
  return undefined;
}

async function startLoopback(
  session: OAuthSession,
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<boolean> {
  if (session.provider === 'claude') {
    const port = await findClaudeLoopbackPort(session, handler);
    if (!port) return false;
    session.redirectUri = `http://localhost:${port}/callback`;
    return true;
  }
  const server = createServer(handler);
  session.server = server;
  try {
    await listenOnce(server, 1455);
    session.redirectUri = CHATGPT_REDIRECT_URI;
    return true;
  } catch (e: any) {
    try {
      server.close();
    } catch {
      /* best effort */
    }
    session.server = undefined;
    if (e?.code === 'EADDRINUSE') return false;
    throw e;
  }
}

function scheduleSessionExpiry(session: OAuthSession): void {
  const ttl = session.expiresAt - Date.now();
  if (ttl <= 0) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    if (sessions.get(session.id) === session) {
      closeSession(session);
    }
  }, ttl);
}

function closeSession(session: OAuthSession): void {
  sessions.delete(session.id);
  if (session.timer) {
    clearTimeout(session.timer);
    session.timer = undefined;
  }
  try {
    session.server?.close();
  } catch {
    /* best effort */
  }
}

async function callbackHandler(
  session: OAuthSession,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const callbackPath = new URL(session.redirectUri).pathname;
    if (url.pathname !== callbackPath) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code) {
      res.writeHead(400);
      res.end('missing code');
      return;
    }
    if (state !== session.state) {
      res.writeHead(400);
      res.end('invalid state');
      return;
    }
    const tokenSet = await exchangeCode(session.provider, code, session.redirectUri, session.verifier, session.state);
    const tokenKey = makeTokenKey(session.provider, tokenSet.accountId, session.id);
    setToken(tokenKey, tokenSet);
    closeSession(session);
    emitStatus(buildStatus(tokenKey, tokenSet, 'success'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>Sign-in complete. You can close this tab.</body></html>');
  } catch (e) {
    const message = (e as Error).message;
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Sign-in failed: ${message}`);
    emitStatus({
      tokenKey: '',
      provider: session.provider,
      connected: false,
      state: 'error',
      message,
    });
  }
}

export async function beginOAuth(provider: OAuthProvider): Promise<OAuthSessionInfo> {
  const { verifier, challenge } = pkcePair();
  const state = provider === 'claude' ? verifier : generateState();
  const session: OAuthSession = {
    id: randomUUID(),
    provider,
    verifier,
    state,
    challenge,
    redirectUri: provider === 'claude' ? CLAUDE_MANUAL_REDIRECT_URI : CHATGPT_REDIRECT_URI,
    mode: 'manual',
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    void callbackHandler(session, req, res);
  };

  sessions.set(session.id, session);
  scheduleSessionExpiry(session);

  const listening = await startLoopback(session, handler);
  if (listening) {
    session.mode = 'loopback';
  }

  const authUrl = buildAuthorizeUrl(provider, session.redirectUri, challenge, state);

  emitStatus({
    tokenKey: '',
    provider,
    connected: false,
    state: 'pending',
  });

  return {
    id: session.id,
    provider,
    authUrl,
    mode: session.mode,
    expiresAt: session.expiresAt,
  };
}

function makeTokenKey(provider: OAuthProvider, accountId: string | undefined, sessionId: string): string {
  return `${provider}:${accountId ?? sessionId.slice(0, 8)}`;
}

/** Extract a code and optional state from a raw code, code#state, or full URL. */
function parsePasted(pasted: string, session: OAuthSession): { code: string; state?: string } {
  const trimmed = pasted.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    const redirect = new URL(session.redirectUri);
    if (url.hostname.toLowerCase() !== redirect.hostname.toLowerCase() || url.pathname !== redirect.pathname) {
      throw new Error('Pasted URL does not match this session\'s redirect URI.');
    }
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    if (!code) throw new Error('No authorization code found in the URL.');
    return { code, state };
  }
  if (trimmed.includes('#')) {
    const [code, state] = trimmed.split('#', 2);
    return { code, state };
  }
  return { code: trimmed };
}

export async function finishOAuth(sessionId: string, pasted: string): Promise<OAuthStatus> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error('OAuth session not found or already completed.');
  if (session.expiresAt < Date.now()) {
    closeSession(session);
    throw new Error('OAuth session has expired. Start again.');
  }

  const { code, state } = parsePasted(pasted, session);
  // A pasted code without a state (bare code or a URL without a state) is accepted
  // as the documented manual-fallback behavior.
  if (state && state !== session.state) {
    throw new Error('Invalid state parameter. The pasted code does not match this session.');
  }

  const tokenSet = await exchangeCode(session.provider, code, session.redirectUri, session.verifier, session.state);
  const tokenKey = makeTokenKey(session.provider, tokenSet.accountId, session.id);
  setToken(tokenKey, tokenSet);
  closeSession(session);
  const status = buildStatus(tokenKey, tokenSet, 'success');
  emitStatus(status);
  return status;
}

export function cancelOAuth(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  closeSession(session);
}

function extractAccountId(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const json = JSON.parse(payload) as Record<string, unknown>;
    const auth = json['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
    return typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

/** Decode the `exp` claim from an unvalidated JWT, returning epoch milliseconds. */
function expFromJwt(jwt: string | undefined): number | undefined {
  if (typeof jwt !== 'string') return undefined;
  const parts = jwt.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const json = JSON.parse(payload) as Record<string, unknown>;
    if (typeof json.exp === 'number') return json.exp * 1000;
  } catch {
    /* malformed or not a JWT */
  }
  return undefined;
}

/** Best-effort expiry for a stored token, falling back to a JWT `exp` claim. */
function tokenExpiresAt(tokenSet: OAuthTokenSet): number | undefined {
  if (tokenSet.expiresAt) return tokenSet.expiresAt;
  if (tokenSet.provider === 'chatgpt') return expFromJwt(tokenSet.accessToken);
  return undefined;
}

function tokenFromResponse(provider: OAuthProvider, json: Record<string, unknown>, obtainedAt: number): OAuthTokenSet {
  const accessToken = json.access_token as string | undefined;
  if (!accessToken) throw new Error('Token response missing access_token.');

  const idToken = json.id_token as string | undefined;
  const accountId = provider === 'chatgpt' ? (idToken ? extractAccountId(idToken) : undefined) : undefined;

  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
  const scopes = json.scope as string | undefined;

  // ChatGPT access tokens are JWTs; their `exp` claim is more reliable than
  // the `expires_in` field when it is missing or rounded down.
  const jwtExp = provider === 'chatgpt' ? expFromJwt(accessToken) : undefined;
  const expiresAt = jwtExp ?? Date.now() + expiresIn * 1000;

  return {
    provider,
    accessToken,
    refreshToken: json.refresh_token as string | undefined,
    expiresAt,
    accountId,
    scopes,
    obtainedAt,
  };
}

async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  redirectUri: string,
  verifier: string,
  state: string,
): Promise<OAuthTokenSet> {
  const isClaude = provider === 'claude';
  const tokenUrl = isClaude ? CLAUDE_TOKEN_URL : CHATGPT_TOKEN_URL;
  const obtainedAt = Date.now();

  let body: string;
  let headers: Record<string, string>;
  if (isClaude) {
    headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    // Anthropic's token endpoint validates the whole body against a schema and
    // rejects it with "Invalid request format" when `state` is absent, even
    // though the code alone would identify the grant.
    body = JSON.stringify({
      client_id: CLAUDE_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      state,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  } else {
    headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CHATGPT_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    body = params.toString();
  }

  const res = await fetch(tokenUrl, { method: 'POST', headers, body });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = String(safeJson(text)?.error_description ?? text.slice(0, 200) ?? `HTTP ${res.status}`);
    throw new Error(`Token exchange failed: ${err}`);
  }
  const json = safeJson(text);
  if (!json) throw new Error('Token response was not valid JSON.');
  const tokenSet = tokenFromResponse(provider, json, obtainedAt);
  if (provider === 'chatgpt' && !tokenSet.accountId) {
    throw new Error('Could not read your ChatGPT account id from the sign-in response.');
  }
  return tokenSet;
}

async function refreshTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
  const isClaude = tokenSet.provider === 'claude';
  const tokenUrl = isClaude ? CLAUDE_TOKEN_URL : CHATGPT_TOKEN_URL;
  const obtainedAt = Date.now();

  if (!tokenSet.refreshToken) throw new Error('No refresh token available.');

  let body: string;
  let headers: Record<string, string>;
  if (isClaude) {
    headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    body = JSON.stringify({
      client_id: CLAUDE_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokenSet.refreshToken,
    });
  } else {
    headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CHATGPT_CLIENT_ID,
      refresh_token: tokenSet.refreshToken,
    });
    body = params.toString();
  }

  const res = await fetch(tokenUrl, { method: 'POST', headers, body });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = String(safeJson(text)?.error_description ?? text.slice(0, 200) ?? `HTTP ${res.status}`);
    if (res.status === 401 || /invalid_grant|expired|revoked/i.test(err)) {
      throw new Error('Subscription session expired. Sign in again.');
    }
    throw new Error(`Token refresh failed: ${err}`);
  }
  const json = safeJson(text);
  if (!json) throw new Error('Token refresh response was not valid JSON.');
  const next = tokenFromResponse(tokenSet.provider, json, obtainedAt);
  if (next.refreshToken == null) next.refreshToken = tokenSet.refreshToken;
  if (next.accountId == null && tokenSet.accountId) next.accountId = tokenSet.accountId;
  if (next.scopes == null && tokenSet.scopes) next.scopes = tokenSet.scopes;
  return next;
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function ensureFreshToken(tokenKey: string, force = false): Promise<string> {
  if (!tokenKey) {
    throw new Error('No token key specified.');
  }
  if (!force) {
    const existing = inFlight.get(tokenKey);
    if (existing) return existing;
  }

  const promise = (async () => {
    const tokenSet = getToken(tokenKey);
    if (!tokenSet) {
      throw new Error(`No subscription token found for ${tokenKey}. Sign in again.`);
    }
    // A missing expiresAt does not mean the token is expired; try to recover
    // the `exp` claim from a ChatGPT JWT, and refresh only if no expiry can be
    // determined or the token is within 60 seconds of expiring.
    const expiresAt = tokenExpiresAt(tokenSet);
    if (!force && expiresAt && expiresAt - 60_000 > Date.now()) {
      return tokenSet.accessToken;
    }
    if (!tokenSet.refreshToken) {
      throw new Error(`Subscription session expired for ${tokenKey}. Sign in again.`);
    }
    const next = await refreshTokenSet(tokenSet);
    setToken(tokenKey, next);
    emitStatus(buildStatus(tokenKey, next, 'success'));
    return next.accessToken;
  })();

  inFlight.set(tokenKey, promise);
  return promise.finally(() => {
    if (inFlight.get(tokenKey) === promise) inFlight.delete(tokenKey);
  });
}

export async function resolveSubscriptionProvider(config: ProviderConfig): Promise<ProviderConfig> {
  if (config.auth !== 'subscription') return config;
  if (!config.tokenKey) {
    throw new Error('Provider is configured for subscription sign-in but has no token key. Sign in again in Settings.');
  }
  const accessToken = await ensureFreshToken(config.tokenKey);
  // Backfill the account id from the stored token set when the provider config
  // lacks one: the CLI-import path (e.g. ~/.codex/auth.json) records it on the
  // token, and the renderer never sees it to save on the config.
  const accountId = config.accountId ?? getToken(config.tokenKey)?.accountId;
  return { ...config, apiKey: accessToken, accountId };
}

export function signOut(tokenKey: string): void {
  deleteToken(tokenKey);
}

export function getOAuthStatus(tokenKey: string): OAuthStatus {
  const tokenSet = getToken(tokenKey);
  return buildStatus(tokenKey, tokenSet, tokenSet ? 'success' : 'missing');
}

/** Parse a timestamp from a CLI credential file, which may be a number or an ISO string. */
function parseCliTimestamp(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? Date.now() : ms;
  }
  return Date.now();
}

export function importCliAuth(): { claude: boolean; chatgpt: boolean } {
  const result = { claude: false, chatgpt: false };

  const claudePath = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(claudePath)) {
    try {
      const raw = readFileSync(claudePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const block = (parsed.claudeAiOauth as Record<string, unknown> | undefined) ?? parsed;
      const accessToken = (block.accessToken as string) ?? (block.access_token as string);
      if (accessToken) {
        const scopesRaw = block.scopes;
        const scopes = Array.isArray(scopesRaw) ? scopesRaw.join(' ') : (scopesRaw as string | undefined);
        setToken('claude', {
          provider: 'claude',
          accessToken,
          refreshToken: (block.refreshToken as string) ?? (block.refresh_token as string),
          expiresAt: (block.expiresAt as number) ?? (block.expires_at as number),
          scopes,
          obtainedAt: Date.now(),
        });
        result.claude = true;
      }
    } catch {
      /* malformed or unreadable credential file */
    }
  }

  const chatgptPath = join(homedir(), '.codex', 'auth.json');
  if (existsSync(chatgptPath)) {
    try {
      const raw = readFileSync(chatgptPath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const tokens = parsed.tokens as Record<string, unknown> | undefined;
      if (tokens?.access_token) {
        const accessToken = tokens.access_token as string;
        const refreshToken = tokens.refresh_token as string | undefined;
        const accountId = tokens.account_id as string | undefined;
        const obtainedAt = parseCliTimestamp(parsed.last_refresh);
        const expiresAt =
          expFromJwt(accessToken) ??
          expFromJwt(tokens.id_token as string) ??
          obtainedAt + CHATGPT_CLI_TOKEN_TTL_MS;
        setToken('chatgpt', {
          provider: 'chatgpt',
          accessToken,
          refreshToken,
          accountId,
          expiresAt,
          obtainedAt,
        });
        result.chatgpt = true;
      }
    } catch {
      /* malformed or unreadable auth file */
    }
  }

  return result;
}
