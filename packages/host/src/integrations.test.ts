import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectAgentTools, installSubagent, isOwnEntry, refreshSubagent, subagentSnippet } from './integrations.js';

/**
 * Subagent installs always run against a throwaway HOME here - the tests must
 * never touch the real ~/.claude.json or ~/.codex/config.toml.
 */
describe('agent-tool detection and subagent install', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nekko-int-'));
  });

  it('reports every tool undetected and not installed on a bare HOME', () => {
    const tools = detectAgentTools(home);
    expect(tools.map((t) => t.id)).toEqual(['claude', 'codex', 'cursor', 'windsurf']);
    for (const t of tools) {
      expect(t.detected).toBe(false);
      expect(t.installed).toBe(false);
      expect(t.configPath).toContain(home);
    }
  });

  it('detects a tool by its config directory', () => {
    mkdirSync(join(home, '.claude'));
    mkdirSync(join(home, '.codex'));
    const tools = detectAgentTools(home);
    expect(tools.find((t) => t.id === 'claude')?.detected).toBe(true);
    expect(tools.find((t) => t.id === 'codex')?.detected).toBe(true);
    expect(tools.find((t) => t.id === 'cursor')?.detected).toBe(false);
  });

  it('merges the nekko-agent entry into ~/.claude.json, preserving other keys', () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }),
    );

    const res = installSubagent('claude', home);
    expect(res.ok).toBe(true);

    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers['nekko-agent']).toEqual({ command: 'npx', args: ['-y', 'nekko-agent', 'mcp'] });

    // The pre-merge file was backed up.
    const bak = JSON.parse(readFileSync(join(home, '.claude.json.bak'), 'utf8'));
    expect(bak.mcpServers['nekko-agent']).toBeUndefined();
    expect(bak.mcpServers.other).toEqual({ command: 'x' });

    expect(detectAgentTools(home).find((t) => t.id === 'claude')?.installed).toBe(true);
  });

  it('creates the config file when the dir exists but the file does not', () => {
    mkdirSync(join(home, '.cursor'));
    const res = installSubagent('cursor', home);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers['nekko-agent'].command).toBe('npx');
    // Nothing existed, so no backup was written.
    expect(existsSync(join(home, '.cursor', 'mcp.json.bak'))).toBe(false);
  });

  it('appends a [mcp_servers] section to Codex config.toml and stays idempotent', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"\n');

    const res = installSubagent('codex', home);
    expect(res.ok).toBe(true);
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[mcp_servers.nekko-agent]');
    expect(text).toContain('args = ["-y", "nekko-agent", "mcp"]');
    expect(readFileSync(join(home, '.codex', 'config.toml.bak'), 'utf8')).toBe('model = "gpt-5"\n');

    // Second install is a no-op success, not a duplicate section.
    const again = installSubagent('codex', home);
    expect(again.ok).toBe(true);
    expect(again.message).toContain('Already installed');
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(text);
  });

  it('refuses to clobber an unparseable config and leaves it untouched', () => {
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude.json'), '{ not json');
    const res = installSubagent('claude', home);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('isn\'t valid JSON');
    expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{ not json');
    expect(existsSync(join(home, '.claude.json.bak'))).toBe(false);
  });

  it('treats an empty-but-present JSON config as a fresh object', () => {
    mkdirSync(join(home, '.cursor'));
    writeFileSync(join(home, '.cursor', 'mcp.json'), '   \n');
    const res = installSubagent('cursor', home);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers['nekko-agent'].command).toBe('npx');
  });

  it('does not count a TOML section header inside a string or comment as installed', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      '# [mcp_servers.nekko-agent]\nnote = "[mcp_servers.nekko-agent]"\n',
    );
    expect(detectAgentTools(home).find((t) => t.id === 'codex')?.installed).toBe(false);
    const res = installSubagent('codex', home);
    expect(res.ok).toBe(true);
    const text = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    expect(text).toContain('[mcp_servers.nekko-agent]\ncommand = "npx"');
  });

  it('refuses to append to a TOML config it cannot read confidently', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'model = "unterminated\nthis is not toml');
    const res = installSubagent('codex', home);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('valid TOML');
    expect(existsSync(join(home, '.codex', 'config.toml.bak'))).toBe(false);
    writeFileSync(join(home, '.codex', 'config.toml'), 'just some words\n');
    const again = installSubagent('codex', home);
    expect(again.ok).toBe(false);
    expect(again.message).toContain('valid TOML');
  });

  it('handles multiline arrays and strings in config.toml', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(
      join(home, '.codex', 'config.toml'),
      'args = [\n  "-y",\n  "nekko-agent",\n]\ndoc = """\nmulti line\n"""\n',
    );
    const res = installSubagent('codex', home);
    expect(res.ok).toBe(true);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.nekko-agent]',
    );
  });

  it('writes the Windsurf MCP config under ~/.codeium/windsurf', () => {
    mkdirSync(join(home, '.windsurf'));
    const res = installSubagent('windsurf', home);
    expect(res.ok).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'utf8'));
    expect(cfg.mcpServers['nekko-agent']).toEqual({ command: 'npx', args: ['-y', 'nekko-agent', 'mcp'] });
  });

  it('will not install into a tool that was never detected', () => {
    const res = installSubagent('cursor', home);
    expect(res.ok).toBe(false);
    expect(res.message).toContain("wasn't found");
    expect(existsSync(join(home, '.cursor'))).toBe(false);
  });

  it('returns a copy-paste snippet per tool with no secrets', () => {
    for (const tool of ['claude', 'codex', 'cursor', 'windsurf'] as const) {
      const s = subagentSnippet(tool);
      expect(s.target).toBeTruthy();
      // Both the server key and the npx package it runs are the current name;
      // the snippet is copy-pasted by users, so it must not advertise an old one.
      expect(s.snippet).toContain('nekko-agent');
    }
    expect(subagentSnippet('codex').snippet).toContain('[mcp_servers.nekko-agent]');
    expect(subagentSnippet('claude').snippet).toContain('"mcpServers"');
  });
});

describe('refreshing entries this app wrote', () => {
  let home: string;
  const target = { url: 'http://127.0.0.1:1439', token: 'fresh', command: '/opt/nekko/bin/nekko-agent' };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nekko-refresh-'));
    mkdirSync(join(home, '.claude'));
  });

  it('recognises only its own entries', () => {
    expect(isOwnEntry('npx', ['-y', 'nekko-agent', 'mcp'])).toBe(true);
    expect(isOwnEntry(String.raw`C:\Users\me\AppData\Roaming\Nekko Agent\bin\nekko-agent.cmd`, ['mcp'])).toBe(true);
    expect(isOwnEntry('node', ['C:/code/nekko-agent/apps/cli/dist/index.js', 'mcp'])).toBe(false);
    expect(isOwnEntry(undefined)).toBe(false);
  });

  it('re-points an npx entry at the running app', () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'nekko-agent': { command: 'npx', args: ['-y', 'nekko-agent', 'mcp'] } } }),
    );
    expect(refreshSubagent('claude', home, target)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    expect(cfg.mcpServers['nekko-agent']).toEqual({
      command: '/opt/nekko/bin/nekko-agent',
      args: ['mcp'],
      env: { NEKKO_URL: 'http://127.0.0.1:1439', NEKKO_TOKEN: 'fresh' },
    });
    // Already current: nothing is rewritten a second time.
    expect(refreshSubagent('claude', home, target)).toBe(false);
  });

  it('never touches an entry someone wrote by hand', () => {
    const own = { command: 'node', args: ['C:/code/nekko-agent/apps/cli/dist/index.js', 'mcp'] };
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'nekko-agent': own } }));
    expect(refreshSubagent('claude', home, target)).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')).mcpServers['nekko-agent']).toEqual(own);
  });

  it('rewrites a stale Codex section in place, keeping the rest of the file', () => {
    mkdirSync(join(home, '.codex'));
    const file = join(home, '.codex', 'config.toml');
    writeFileSync(
      file,
      'model = "o4"\n\n[mcp_servers.nekko-agent]\ncommand = "npx"\nargs = ["-y", "nekko-agent", "mcp"]\n\n[profiles.fast]\nmodel = "mini"\n',
    );
    expect(refreshSubagent('codex', home, target)).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('command = "/opt/nekko/bin/nekko-agent"');
    expect(text).toContain('NEKKO_TOKEN = "fresh"');
    expect(text).toContain('[profiles.fast]');
    expect(text.match(/\[mcp_servers\.nekko-agent\]/g)).toHaveLength(1);
  });
});
