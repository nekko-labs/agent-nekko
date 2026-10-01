/** OAuth types and payloads shared between the host, IPC contracts, and UI. */

export type OAuthProvider = 'claude' | 'chatgpt' | 'openrouter';

export interface OAuthTokenSet {
  provider: OAuthProvider;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  /** ChatGPT account id decoded from the id_token. */
  accountId?: string;
  /** Space-separated scopes, or the raw string the vendor returned. */
  scopes?: string;
  /** Epoch milliseconds when this set was obtained or refreshed. */
  obtainedAt: number;
}

export interface OAuthSessionInfo {
  id: string;
  provider: OAuthProvider;
  authUrl: string;
  /** 'loopback' waits for the local callback; 'manual' needs finishOAuth(code). */
  mode: 'loopback' | 'manual';
  /** Epoch milliseconds when the session expires if not completed. */
  expiresAt: number;
}

/**
 * Sanitized status for a token key. Never carries the access token itself,
 * so it is safe to ship over IPC and event buses.
 */
export interface OAuthStatus {
  tokenKey: string;
  provider?: OAuthProvider;
  connected: boolean;
  accountId?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  scopes?: string;
  state?: 'pending' | 'success' | 'error' | 'missing';
  message?: string;
}
