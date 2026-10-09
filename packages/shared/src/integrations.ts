/**
 * Agent-CLI tools Nekko Agent can be installed into as an MCP subagent. The
 * host detects each tool by its config directory and merges an `nekko-agent`
 * server entry into its MCP config file, backing the file up to `<file>.bak`
 * first. On the desktop the entry carries the local server's address and
 * bearer token (see `SubagentTarget`), so a snippet can hold that token: it is
 * the same one the Server tab already shows, on the same machine.
 */

export type AgentToolId = 'claude' | 'codex' | 'cursor' | 'windsurf';

export interface AgentToolStatus {
  id: AgentToolId;
  label: string;
  /** The config file the MCP entry would be merged into. */
  configPath: string;
  /** The tool's config directory exists, i.e. the CLI is installed/has run. */
  detected: boolean;
  /** The nekko-agent MCP entry is already present. */
  installed: boolean;
}

/** The manual copy-paste fallback for a tool: where it goes and what to paste. */
export interface SubagentSnippet {
  /** Where the snippet belongs, e.g. "~/.claude.json → mcpServers". */
  target: string;
  snippet: string;
}

export interface SubagentInstallResult {
  ok: boolean;
  message?: string;
  tools: AgentToolStatus[];
}

/**
 * How a written MCP entry should reach this Nekko Agent.
 *
 * Without it the entry is `npx -y nekko-agent mcp` with no environment, which
 * starts a *second* copy of the agent on the same data directory rather than
 * driving the app the user is looking at. With it, the entry names the CLI the
 * app installed and carries the address and token of the running server, so
 * the other tool gets this window's workspaces, sessions and providers.
 */
export interface SubagentTarget {
  /** Base URL of the local API server, e.g. `http://127.0.0.1:1439`. */
  url?: string;
  /** Bearer token for that server. */
  token?: string;
  /** Absolute path of the CLI launcher the app installed, if it has one. */
  command?: string;
}
