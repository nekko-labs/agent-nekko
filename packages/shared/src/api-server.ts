/**
 * The local API server: Agent Nekko, reachable by other programs.
 *
 * The desktop app already holds everything worth driving — the providers, the
 * workspaces, the sessions with their history — and until now the only way in
 * was the window. Turning this on puts the same host behind `POST /api/:channel`
 * and a `/api/events` socket on this machine, which is the surface the CLI and
 * the MCP server already speak. So `agent-nekko chat "…"` in a terminal, or
 * Claude Code over MCP, talks to *this* app rather than to a second copy of it
 * running on the same files.
 *
 * Off by default, and every default that follows is the safe one: loopback
 * only, a token required, and a token generated rather than left empty.
 */

/** What the local API server is configured to do. */
export interface ApiServerSettings {
  /** Serve on start-up and keep serving. */
  enabled: boolean;
  port: number;
  /** `local` = 127.0.0.1 only. `lan` exposes it to the whole network. */
  bind: 'local' | 'lan';
  /**
   * Required as `Authorization: Bearer <token>` on every request. Never empty
   * while the server is enabled: an unauthenticated agent endpoint is a remote
   * shell, and the one on a laptop's network is a remote shell for the café.
   */
  token: string;
}

/** Live state of the local API server, as the Models tab shows it. */
export interface ApiServerStatus {
  settings: ApiServerSettings;
  running: boolean;
  /**
   * Whether this edition can switch a server on at all. False in the web and
   * self-hosted editions, which *are* the server already: there is nothing to
   * start, and a toggle that admits that is better than one that does nothing.
   */
  available?: boolean;
  /** The base URL other tools point at, when it is up. */
  url?: string;
  /** Why it is not up, when it was asked to be. */
  error?: string;
  /** Open event sockets right now, so "is anything connected" has an answer. */
  clients: number;
  /**
   * Requests served since it started, and when the last one arrived. Proof the
   * thing at the other end actually reached it, which is the question anyone
   * wiring up a CLI is really asking.
   */
  requests: number;
  lastRequestAt?: number;
}

export const API_SERVER_PORT_DEFAULT = 1439;

export const DEFAULT_API_SERVER_SETTINGS: ApiServerSettings = {
  enabled: false,
  port: API_SERVER_PORT_DEFAULT,
  bind: 'local',
  token: '',
};

/** The settings with anything missing filled in, for an install that predates them. */
export function withApiServerDefaults(settings: Partial<ApiServerSettings> | undefined): ApiServerSettings {
  return { ...DEFAULT_API_SERVER_SETTINGS, ...settings };
}

/** The base URL a client should use for these settings. */
export function apiServerUrl(settings: ApiServerSettings, host = '127.0.0.1'): string {
  return `http://${settings.bind === 'lan' ? host : '127.0.0.1'}:${settings.port}`;
}

/**
 * Why these settings cannot be served, or null when they can.
 *
 * Checked in the shared package because both ends need the same answer: the UI
 * to say so before saving, and the host to refuse to listen regardless of what
 * the UI allowed through.
 */
export function apiServerRefusal(settings: ApiServerSettings): string | null {
  if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
    return 'Pick a port between 1024 and 65535.';
  }
  if (!settings.token.trim()) {
    return 'A token is required. Anything that can reach this port can otherwise run the agent.';
  }
  return null;
}

/** The env two lines of shell need to point the CLI at this server. */
export function apiServerEnvLines(url: string, token: string): string[] {
  return [`export NEKKO_URL=${url}`, `export NEKKO_TOKEN=${token}`];
}

/** The MCP entry other agent tools need, as the JSON they paste. */
export function apiServerMcpConfig(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'agent-nekko': {
          command: 'npx',
          args: ['-y', 'agent-nekko', 'mcp'],
          env: { NEKKO_URL: url, NEKKO_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}
