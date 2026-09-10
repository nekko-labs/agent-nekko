/**
 * Agent-CLI tools Agent Nekko can be installed into as an MCP subagent
 * (`npx -y agent-nekko mcp`). The host detects each tool by its config directory
 * and merges an `agent-nekko` server entry into its MCP config file, backing
 * the file up to `<file>.bak` first. No secrets cross this surface: only
 * detection booleans, config paths, and copy-paste snippets.
 */

export type AgentToolId = 'claude' | 'codex' | 'cursor' | 'windsurf';

export interface AgentToolStatus {
  id: AgentToolId;
  label: string;
  /** The config file the MCP entry would be merged into. */
  configPath: string;
  /** The tool's config directory exists, i.e. the CLI is installed/has run. */
  detected: boolean;
  /** The agent-nekko (or legacy kotrain) MCP entry is already present. */
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
