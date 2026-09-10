import React, { useEffect, useState } from 'react';
import type { AgentToolId, AgentToolStatus, SubagentSnippet } from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { Badge } from '../primitives/index.js';
import { ConnectorGrid } from '../ConnectorGrid.js';
import { CheckIcon, CopyIcon, TerminalIcon } from '../../icons.js';

/**
 * The integrations step, two groups. "Use Nekko inside other tools" installs
 * this app as an MCP subagent (`npx -y kotrain mcp`) into detected agent CLIs:
 * the host merges an `agent-nekko` entry into the tool's MCP config, backing up
 * the file first, and a manual copy-paste snippet is always offered. "Connect
 * your apps" is the shared connector grid in compact form. Everything is
 * idempotent - an installed tool reads as connected and can't be added twice.
 */
export function IntegrationsStep() {
  const { pushToast } = useStore();
  const [tools, setTools] = useState<AgentToolStatus[] | null>(null);
  const [installing, setInstalling] = useState<AgentToolId | null>(null);
  const [snippetFor, setSnippetFor] = useState<AgentToolId | null>(null);

  useEffect(() => {
    let alive = true;
    window.kotrain
      .detectAgentTools()
      .then((list) => {
        if (alive) setTools(list);
      })
      .catch(() => {
        if (alive) setTools([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const install = async (id: AgentToolId) => {
    if (installing) return;
    setInstalling(id);
    try {
      const res = await window.kotrain.installSubagent(id);
      setTools(res.tools);
      pushToast(
        res.ok ? 'success' : 'error',
        res.ok
          ? `Agent Nekko is now an MCP server in ${res.tools.find((t) => t.id === id)?.label ?? id}. Restart the tool to pick it up.`
          : (res.message ?? 'Install failed.'),
      );
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="w-full">
      <h1 className="text-center text-2xl font-semibold tracking-tight">Meet your tools</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-[14px] leading-relaxed text-ink-soft">
        Agent Nekko can run as a subagent inside the agent CLIs you already use, and plug into your
        apps so chats and workflows can reach them.
      </p>

      <section className="mt-6 w-full">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--info)' }} />
          <h2 className="text-[15px] font-semibold">Use Nekko inside other tools</h2>
        </div>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          Adds an MCP server entry to the tool's config; the original file is backed up first.
        </p>
        <div className="mt-3 space-y-2">
          {tools === null && (
            <p
              className="rounded-xl border border-dashed p-4 text-[12px] text-ink-faint"
              style={{ borderColor: 'var(--line)' }}
            >
              Checking for Claude Code, Codex, Cursor, and Windsurf…
            </p>
          )}
          {tools !== null && tools.length === 0 && (
            <p
              className="rounded-xl border border-dashed p-4 text-[12px] text-ink-faint"
              style={{ borderColor: 'var(--line)' }}
            >
              Couldn't check for agent tools here. You can still copy the config from the Connectors
              tab later.
            </p>
          )}
          {(tools ?? []).map((tool) => (
            <AgentToolCard
              key={tool.id}
              tool={tool}
              installing={installing === tool.id}
              snippetOpen={snippetFor === tool.id}
              onInstall={() => void install(tool.id)}
              onToggleSnippet={() => setSnippetFor((s) => (s === tool.id ? null : tool.id))}
            />
          ))}
          {tools !== null && tools.length > 0 && !tools.some((t) => t.detected) && (
            <p
              className="rounded-xl border border-dashed p-4 text-[12px] text-ink-faint"
              style={{ borderColor: 'var(--line)' }}
            >
              No agent CLIs detected yet. Each card above can still give you the config to paste when
              you install one.
            </p>
          )}
        </div>
      </section>

      <section className="mt-6 w-full">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent)' }} />
          <h2 className="text-[15px] font-semibold">Connect your apps</h2>
        </div>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          GitHub, Linear, Slack, Discord, Jira, Teams, Gmail, and Drive. Skip any of these - they live
          in the Connectors tab too.
        </p>
        <div className="mt-3">
          <ConnectorGrid compact />
        </div>
      </section>
    </div>
  );
}

function AgentToolCard({
  tool,
  installing,
  snippetOpen,
  onInstall,
  onToggleSnippet,
}: {
  tool: AgentToolStatus;
  installing: boolean;
  snippetOpen: boolean;
  onInstall: () => void;
  onToggleSnippet: () => void;
}) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: 'var(--line)' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="grid h-8 w-8 shrink-0 place-items-center rounded-xl text-ink-faint"
            style={{ background: 'var(--surface-2)' }}
          >
            <TerminalIcon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[14px] font-semibold">{tool.label}</h3>
              {tool.installed && (
                <Badge tone="success" variant="soft">
                  <CheckIcon className="h-3 w-3" /> Connected
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              {tool.installed
                ? 'The agent-nekko MCP server is in this tool\'s config.'
                : tool.detected
                  ? 'Detected - add Agent Nekko as an MCP server.'
                  : 'Not detected on this machine.'}
            </p>
          </div>
        </div>
        {!tool.installed && tool.detected && (
          <button
            className="btn btn-primary shrink-0 py-1.5 text-[12px]"
            onClick={onInstall}
            disabled={installing}
          >
            {installing ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <button className="text-[12px] text-ink-faint hover:text-ink" onClick={onToggleSnippet}>
          {snippetOpen ? 'Hide manual setup' : 'Set up manually'}
        </button>
        <span className="truncate font-mono text-[11px] text-ink-faint" title={tool.configPath}>
          {tool.configPath}
        </span>
      </div>
      {snippetOpen && <ManualSnippet id={tool.id} />}
    </div>
  );
}

/** The copy-paste fallback: where the entry goes plus the snippet itself. */
function ManualSnippet({ id }: { id: AgentToolId }) {
  const [snippet, setSnippet] = useState<SubagentSnippet | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    // A different tool means a fresh snippet and a fresh copy state.
    setSnippet(null);
    setFailed(false);
    setCopied(false);
    window.kotrain
      .subagentSnippet(id)
      .then((s) => {
        if (alive) setSnippet(s);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [id]);

  const copy = async () => {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet.snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard can be unavailable; the text is right there to select */
    }
  };

  if (failed) {
    return <p className="mt-2 text-[11px] text-ink-faint">Couldn't load the manual config.</p>;
  }
  if (!snippet) {
    return <p className="mt-2 text-[11px] text-ink-faint">Loading config…</p>;
  }
  return (
    <div className="mt-2 rounded-xl p-3" style={{ background: 'var(--surface-2)' }}>
      <p className="text-[11px] text-ink-faint">
        Add this to <span className="font-mono">{snippet.target}</span>:
      </p>
      <pre className="mt-1.5 overflow-x-auto text-[11px] leading-relaxed">{snippet.snippet}</pre>
      <button className="btn btn-outline mt-2 px-2 py-1 text-[11px]" onClick={() => void copy()}>
        <CopyIcon className="mr-1 inline h-3 w-3" />
        {copied ? 'Copied' : 'Copy config'}
      </button>
    </div>
  );
}
