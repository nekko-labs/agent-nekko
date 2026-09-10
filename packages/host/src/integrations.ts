import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { AgentToolId, AgentToolStatus, SubagentInstallResult, SubagentSnippet } from '@agent-nekko/shared';
import { backupFile, writeJsonAtomic, writeTextAtomic } from './secure-file.js';

/**
 * Installing Agent Nekko as an MCP subagent inside other agent CLIs. Each tool
 * is detected by its user-level config directory; install merges an
 * `agent-nekko` entry (`npx -y kotrain mcp`, the portable invocation) into the
 * tool's MCP config file. The existing file is copied to `<file>.bak` before
 * any write, and writes go through the atomic temp+rename helpers so a crash
 * can't leave a half-written config.
 *
 * A `home` parameter is accepted by every function so tests (and unusual
 * setups) can point at a scratch HOME instead of the real one.
 */

/** The server key written into every tool's MCP config. */
const SERVER_NAME = 'agent-nekko';
/** Older installs registered under this key; they count as installed. */
const LEGACY_SERVER_NAMES = ['kotrain'];
/** The portable command every tool gets: the bundled CLI over stdio. */
const MCP_ENTRY = { command: 'npx', args: ['-y', 'kotrain', 'mcp'] };

interface AgentToolSpec {
  id: AgentToolId;
  label: string;
  /** User-level config dirs; any of them existing means the tool is present. */
  detectDirs: string[];
  /** The MCP config file, relative to home. */
  configFile: string;
  format: 'json' | 'toml';
  /** Human-readable target for the manual snippet, e.g. "~/.claude.json → mcpServers". */
  snippetTarget: string;
}

const TOOLS: AgentToolSpec[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    detectDirs: ['.claude'],
    configFile: '.claude.json',
    format: 'json',
    snippetTarget: '~/.claude.json → "mcpServers"',
  },
  {
    id: 'codex',
    label: 'Codex',
    detectDirs: ['.codex'],
    configFile: join('.codex', 'config.toml'),
    format: 'toml',
    snippetTarget: '~/.codex/config.toml',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detectDirs: ['.cursor'],
    configFile: join('.cursor', 'mcp.json'),
    format: 'json',
    snippetTarget: '~/.cursor/mcp.json → "mcpServers"',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    detectDirs: ['.windsurf', join('.codeium', 'windsurf')],
    configFile: join('.codeium', 'windsurf', 'mcp_config.json'),
    format: 'json',
    snippetTarget: '~/.codeium/windsurf/mcp_config.json → "mcpServers"',
  },
];

/** The TOML block appended to Codex's config.toml. */
const TOML_SECTION = `[mcp_servers.${SERVER_NAME}]\ncommand = "npx"\nargs = ["-y", "agent-nekko", "mcp"]\n`;

/** Matches an existing `[mcp_servers.agent-nekko]`/`[mcp_servers.kotrain]` table header, bare or quoted. */
const TOML_ENTRY_RE = new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*"?(?:${[SERVER_NAME, ...LEGACY_SERVER_NAMES].join('|')})"?\\s*\\]\\s*$`,
  'm',
);

/**
 * Lightweight TOML safety net. There is no TOML parser in the stdlib and new
 * dependencies are off the table, so this is a lexical pass rather than a full
 * parse. `scanToml` blanks out string contents (basic "…", literal '…', and
 * their multiline """/''' forms, with \ escapes in basic strings) and `#`
 * comments, which keeps a `[table]` header from matching inside a string or
 * comment. `tomlLooksParseable` then requires every remaining line to look
 * like a `[table]` header, a `key = value` pair, or part of a multiline
 * array/inline-table value.
 *
 * Known limit: the value half of a `key = value` line is only checked for
 * bracket balance, not validated, so subtly invalid values still count as
 * parseable. The conservative direction is preserved: anything that doesn't
 * fit this shape is "not confident" and the install refuses to edit the file
 * rather than guess.
 */
interface TomlScan {
  /** Source with string/comment contents replaced by spaces. */
  clean: string;
  /** False when the file can't be read confidently; don't edit it. */
  confident: boolean;
}

function scanToml(text: string): TomlScan {
  const chars = text.split('');
  const blank = (i: number) => {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c + c + c, i);
      const end = triple ? c + c + c : c;
      for (let k = 0; k < end.length; k++) blank(i + k);
      i += end.length;
      let closed = false;
      while (i < text.length) {
        if (text.startsWith(end, i)) {
          for (let k = 0; k < end.length; k++) blank(i + k);
          i += end.length;
          closed = true;
          break;
        }
        if (!triple && text[i] === '\n') break; // bare newline: unterminated
        if (c === '"' && text[i] === '\\') {
          // A backslash escapes the next char in basic strings ("" and """).
          blank(i);
          if (i + 1 < text.length) blank(i + 1);
          i += 2;
          continue;
        }
        blank(i++);
      }
      if (!closed) {
        // An unterminated string makes everything after it untrustworthy.
        while (i < text.length) blank(i++);
        return { clean: chars.join(''), confident: false };
      }
      continue;
    }
    i++;
  }
  return { clean: chars.join(''), confident: true };
}

/** A `[table]` or `[[array-of-tables]]` header line, on stripped text. */
const TOML_HEADER_LINE_RE = /^\[\[?[^\[\]]+\]?\]$/;
/** A bare TOML key, possibly dotted (`a.b.c`). Quoted keys are already blank. */
const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+(\s*\.\s*[A-Za-z0-9_-]+)*$/;

function tomlLooksParseable(clean: string): boolean {
  let depth = 0; // unclosed [ / { inside a value
  const countBrackets = (s: string): boolean => {
    for (const ch of s) {
      if (ch === '[' || ch === '{') depth++;
      else if (ch === ']' || ch === '}') depth--;
      if (depth < 0) return false;
    }
    return true;
  };
  for (const rawLine of clean.split('\n')) {
    const line = rawLine.trim();
    if (depth > 0) {
      // Continuation of a multiline array or inline table; only the bracket
      // balance matters here.
      if (!countBrackets(line)) return false;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('[')) {
      if (!TOML_HEADER_LINE_RE.test(line)) return false;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) return false;
    const key = line.slice(0, eq).trim();
    // An empty key is a blanked-out quoted key; that's fine.
    if (key && !TOML_BARE_KEY_RE.test(key)) return false;
    if (!countBrackets(line.slice(eq + 1))) return false;
  }
  return depth === 0;
}

interface TomlCheck {
  installed: boolean;
  /** False when the file can't be read confidently; don't edit it. */
  confident: boolean;
}

function checkTomlConfig(text: string): TomlCheck {
  const { clean, confident } = scanToml(text);
  if (!confident || !tomlLooksParseable(clean)) return { installed: false, confident: false };
  return { installed: TOML_ENTRY_RE.test(clean), confident: true };
}

function specFor(tool: AgentToolId): AgentToolSpec | undefined {
  return TOOLS.find((t) => t.id === tool);
}

/** Read the tool's config file if present; `undefined` when it doesn't exist. */
function readConfig(spec: AgentToolSpec, home: string): string | undefined {
  const path = join(home, spec.configFile);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isInstalled(spec: AgentToolSpec, home: string): boolean {
  const text = readConfig(spec, home);
  if (!text) return false;
  if (spec.format === 'toml') return checkTomlConfig(text).installed;
  try {
    const cfg = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    const servers = cfg?.mcpServers ?? {};
    return Boolean(servers[SERVER_NAME] || LEGACY_SERVER_NAMES.some((n) => servers[n]));
  } catch {
    return false; // unparseable config isn't "installed"; install reports it
  }
}

/** Which agent CLIs have a config dir, and whether Nekko is already wired in. */
export function detectAgentTools(home: string = homedir()): AgentToolStatus[] {
  return TOOLS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    configPath: join(home, spec.configFile),
    detected: spec.detectDirs.some((d) => existsSync(join(home, d))),
    installed: isInstalled(spec, home),
  }));
}

/**
 * Merge the agent-nekko MCP entry into a tool's config. Idempotent: an existing
 * entry is reported as already installed rather than duplicated. Returns the
 * refreshed tool list either way so callers can re-render from one response.
 */
export function installSubagent(tool: AgentToolId, home: string = homedir()): SubagentInstallResult {
  const spec = specFor(tool);
  if (!spec) return { ok: false, message: 'Unknown tool.', tools: detectAgentTools(home) };

  const detected = spec.detectDirs.some((d) => existsSync(join(home, d)));
  if (!detected) {
    return {
      ok: false,
      message: `${spec.label} wasn't found on this machine. Install it first, or use the manual config.`,
      tools: detectAgentTools(home),
    };
  }
  if (isInstalled(spec, home)) {
    return { ok: true, message: `Already installed in ${spec.label}.`, tools: detectAgentTools(home) };
  }

  const path = join(home, spec.configFile);
  if (spec.format === 'json') {
    let cfg: Record<string, unknown> = {};
    const text = readConfig(spec, home);
    if (text !== undefined) {
      try {
        // An empty-but-present file is a fresh config, not a parse failure.
        const parsed = text.trim() === '' ? {} : JSON.parse(text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed;
      } catch {
        // Never clobber a config we can't parse; the backup isn't even written
        // so the file is exactly as the tool left it.
        return {
          ok: false,
          message: `${spec.configFile} isn't valid JSON. Fix it by hand or add the entry manually.`,
          tools: detectAgentTools(home),
        };
      }
    }
    const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>;
    cfg.mcpServers = { ...servers, [SERVER_NAME]: { ...MCP_ENTRY } };
    backupFile(path);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, cfg);
  } else {
    const text = readConfig(spec, home);
    if (text !== undefined && !checkTomlConfig(text).confident) {
      // Never append to a config we can't read confidently; the backup isn't
      // even written so the file is exactly as the tool left it.
      return {
        ok: false,
        message: `${spec.configFile} doesn't look like valid TOML. Fix it by hand or add the entry manually.`,
        tools: detectAgentTools(home),
      };
    }
    const body = (text ?? '').replace(/\s+$/, '');
    const next = body ? `${body}\n\n${TOML_SECTION}` : TOML_SECTION;
    backupFile(path);
    mkdirSync(dirname(path), { recursive: true });
    writeTextAtomic(path, next);
  }
  return { ok: true, tools: detectAgentTools(home) };
}

/** The manual copy-paste fallback: where the snippet goes and what to paste. */
export function subagentSnippet(tool: AgentToolId): SubagentSnippet {
  const spec = specFor(tool);
  if (!spec) return { target: '', snippet: '' };
  if (spec.format === 'toml') {
    return { target: spec.snippetTarget, snippet: TOML_SECTION.trimEnd() };
  }
  return {
    target: spec.snippetTarget,
    snippet: `"mcpServers": {\n  "${SERVER_NAME}": {\n    "command": "npx",\n    "args": ["-y", "agent-nekko", "mcp"]\n  }\n}`,
  };
}
