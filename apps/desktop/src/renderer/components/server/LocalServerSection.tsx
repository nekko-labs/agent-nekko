import React, { useCallback, useEffect, useState } from 'react';
import type { AgentToolId, AgentToolStatus, ApiServerStatus, SubagentSnippet } from '@agent-nekko/shared';
import {
  apiServerEnvLines,
  apiServerMcpConfig,
  apiServerRefusal,
} from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { Badge } from '../primitives/index.js';
import { CheckIcon, CopyIcon, TerminalIcon } from '../../icons.js';

/**
 * Agent Nekko as something other programs can drive, as one block on the Models
 * tab.
 *
 * The engine section above it answers "what runs my models"; this one answers
 * the question right after it, which every local-model app eventually has to:
 * *how do I get at this from outside the window*. Three surfaces, because there
 * are three answers and they build on each other — a server on this machine, a
 * CLI that talks to it, and an MCP entry so other agents can.
 *
 * The CLI and MCP tabs read the live token, so what they show is the command
 * that works right now rather than a documentation example with placeholders in
 * it.
 */

const POLL_MS = 4000;

type Tab = 'server' | 'cli' | 'mcp';

export function LocalServerSection() {
  const pushToast = useStore((s) => s.pushToast);
  const [status, setStatus] = useState<ApiServerStatus | null>(null);
  const [tab, setTab] = useState<Tab>('server');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setStatus(await window.nekko.apiServerStatus().catch(() => null));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (!status) return null;

  const { settings, running } = status;
  // The web and self-hosted editions are already serving this page, so there is
  // nothing here to switch on: the CLI and MCP tabs still apply, the server one
  // says where it is instead of offering to start it.
  const canToggle = status.available !== false;

  const save = async (patch: Parameters<typeof window.nekko.apiServerSave>[0]) => {
    setBusy(true);
    const next = await window.nekko.apiServerSave(patch).catch((e: Error) => {
      pushToast('error', e.message);
      return null;
    });
    setBusy(false);
    if (next) {
      setStatus(next);
      if (next.error) pushToast('error', next.error);
    }
  };

  // Everything the CLI and MCP tabs quote needs an address, and before the
  // server has ever run there isn't one. The saved settings still describe
  // where it *will* be, which is what makes those tabs readable while it's off.
  const url = status.url ?? `http://127.0.0.1:${settings.port}`;

  return (
    <section className="mt-7">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--accent-2)' }} />
        <h2 className="text-[15px] font-semibold">Agent Nekko as a server</h2>
        {running ? (
          <Badge tone="success" variant="solid" className="px-2 py-0.5">
            <CheckIcon className="h-3 w-3" /> Serving
          </Badge>
        ) : (
          <span className="chip">off</span>
        )}
        {status.available === false && <span className="chip">this edition</span>}
      </div>
      <p className="mt-0.5 text-[12px] text-ink-faint">
        Drive this app from somewhere else: a local API other programs can call, the{' '}
        <span className="font-mono">agent-nekko</span> command line, and an MCP server other agents can use as a
        subagent.
      </p>

      <div className="card mt-3 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot running={running} busy={busy} />
          <span className="text-[13px]">{running ? 'Running' : 'Stopped'}</span>
          {running && (
            <span className="text-[11px] text-ink-faint">
              {status.requests} request{status.requests === 1 ? '' : 's'}
              {status.clients > 0 ? ` · ${status.clients} listening` : ''}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {running && <CopyPill value={`${url}/api`} title="Copy the address other tools should point at" />}
            {canToggle && (
              <button
                className="btn btn-outline py-1 text-[12px]"
                disabled={busy}
                onClick={() => save({ enabled: !settings.enabled })}
              >
                {busy ? 'Working…' : settings.enabled ? 'Stop' : 'Start'}
              </button>
            )}
          </div>
        </div>

        {status.error && (
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--danger)' }}>
            {status.error}
          </p>
        )}
        {settings.bind === 'lan' && running && (
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--warning)' }}>
            Reachable from your whole network on port {settings.port}. Anything with the token can run the agent,
            including its shell and file tools.
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-1.5 border-b pb-2" style={{ borderColor: 'var(--line)' }}>
          <TabButton active={tab === 'server'} onClick={() => setTab('server')}>Server</TabButton>
          <TabButton active={tab === 'cli'} onClick={() => setTab('cli')}>CLI</TabButton>
          <TabButton active={tab === 'mcp'} onClick={() => setTab('mcp')}>MCP</TabButton>
        </div>

        <div className="mt-3">
          {tab === 'server' &&
            (canToggle ? (
              <ServerTab status={status} busy={busy} onSave={save} />
            ) : (
              <p className="text-[12px] text-ink-soft">
                This edition already is the Agent Nekko server — it is serving this page. Point the CLI and MCP
                clients at <span className="font-mono">{url}</span> with the token that server was started with
                (<span className="font-mono">NEKKO_TOKEN</span>).
              </p>
            ))}
          {tab === 'cli' && <CliTab url={url} token={settings.token} running={running} />}
          {tab === 'mcp' && <McpTab url={url} token={settings.token} running={running} />}
        </div>
      </div>
    </section>
  );
}

function ServerTab({
  status,
  busy,
  onSave,
}: {
  status: ApiServerStatus;
  busy: boolean;
  onSave: (patch: Parameters<typeof window.nekko.apiServerSave>[0]) => Promise<void>;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [draft, setDraft] = useState(status.settings);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => setDraft(status.settings), [status.settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(status.settings);
  const refusal = apiServerRefusal({ ...draft, token: draft.token || 'pending' });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Port" hint="The address the CLI and MCP clients point at.">
          <input
            type="number"
            className="input w-28 py-1 text-[12px]"
            min={1024}
            max={65535}
            value={draft.port}
            onChange={(e) => setDraft({ ...draft, port: Number(e.target.value) })}
          />
        </Field>

        <Field
          label="Reachable from"
          hint={
            draft.bind === 'lan'
              ? 'Anything on your network that has the token can run the agent here.'
              : 'Only this computer. The safe default.'
          }
        >
          <select
            className="input w-40 py-1 text-[12px]"
            value={draft.bind}
            onChange={(e) => setDraft({ ...draft, bind: e.target.value as 'local' | 'lan' })}
          >
            <option value="local">This computer only</option>
            <option value="lan">This computer and my network</option>
          </select>
        </Field>
      </div>

      <div>
        <div className="flex items-center justify-between gap-3">
          <label className="text-[12px]">Token</label>
          <div className="flex items-center gap-2">
            <code className="max-w-[220px] truncate rounded-md px-2 py-1 font-mono text-[11px]" style={{ background: 'var(--surface-2)' }}>
              {status.settings.token ? (revealed ? status.settings.token : '•'.repeat(18)) : 'generated when you start it'}
            </code>
            {status.settings.token && (
              <>
                <button className="text-[11px] text-ink-faint hover:text-ink" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? 'Hide' : 'Show'}
                </button>
                <CopyPill value={status.settings.token} title="Copy the token" compact />
              </>
            )}
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-ink-faint">
          Sent as <span className="font-mono">Authorization: Bearer …</span> on every request. There is no
          unauthenticated mode: this endpoint can run shell commands.
        </p>
        <button
          className="mt-1.5 text-[11.5px] text-ink-faint hover:text-ink"
          onClick={async () => {
            if (!window.confirm('Roll the token? Anything already using the old one stops working.')) return;
            await window.nekko.apiServerNewToken();
            pushToast('success', 'New token. Update whatever was using the old one.');
          }}
        >
          Roll the token
        </button>
      </div>

      {refusal && <p className="text-[11.5px]" style={{ color: 'var(--danger)' }}>{refusal}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="btn btn-primary py-1.5 text-[12px]"
          onClick={() => onSave(draft)}
          disabled={!dirty || busy || !!refusal}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="btn btn-ghost py-1.5 text-[12px]" onClick={() => setDraft(status.settings)}>
            Discard
          </button>
        )}
      </div>

      {status.lastRequestAt && (
        <p className="border-t pt-3 text-[11.5px] text-ink-faint" style={{ borderColor: 'var(--line)' }}>
          Last request {new Date(status.lastRequestAt).toLocaleTimeString()}.
        </p>
      )}
    </div>
  );
}

function CliTab({ url, token, running }: { url: string; token: string; running: boolean }) {
  const env = apiServerEnvLines(url, token || '<start the server to get a token>');
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-soft">
        The same agent, from a terminal. Installed once, it works against this app while the server is on, and
        against your local data directory when it is off.
      </p>
      <Step n={1} label="Install it">
        <Command value="npm install -g agent-nekko" />
      </Step>
      <Step n={2} label="Point it at this app">
        <Command value={env.join('\n')} />
        {!running && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--warning)' }}>
            The server is off, so nothing is listening on this address yet.
          </p>
        )}
      </Step>
      <Step n={3} label="Use it">
        <Command value={'agent-nekko status\nagent-nekko chat "summarize the changes on this branch"\nagent-nekko sessions --json'} />
      </Step>
      <p className="text-[11px] text-ink-faint">
        <span className="font-mono">agent-nekko --help</span> lists every command: sessions, workspaces, tasks,
        skills, workflows and training runs.
      </p>
    </div>
  );
}

function McpTab({ url, token, running }: { url: string; token: string; running: boolean }) {
  const pushToast = useStore((s) => s.pushToast);
  const [tools, setTools] = useState<AgentToolStatus[] | null>(null);
  const [installing, setInstalling] = useState<AgentToolId | null>(null);
  const [snippet, setSnippet] = useState<(SubagentSnippet & { id: AgentToolId }) | null>(null);

  useEffect(() => {
    let alive = true;
    window.nekko
      .detectAgentTools()
      .then((list) => alive && setTools(list))
      .catch(() => alive && setTools([]));
    return () => {
      alive = false;
    };
  }, []);

  const install = async (id: AgentToolId) => {
    setInstalling(id);
    try {
      const res = await window.nekko.installSubagent(id);
      setTools(res.tools);
      pushToast(res.ok ? 'success' : 'error', res.ok
        ? `Added. Restart ${res.tools.find((t) => t.id === id)?.label ?? id} to pick it up.`
        : res.message ?? 'Install failed.');
    } catch (e) {
      pushToast('error', (e as Error).message);
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-soft">
        Agent Nekko is also an MCP server, so Claude Code, Codex, Cursor or Windsurf can use it as a subagent:
        your workspaces, skills and sessions become tools they can call.
      </p>

      <div className="space-y-2">
        {tools === null && <p className="text-[12px] text-ink-faint">Checking which tools are installed…</p>}
        {tools?.length === 0 && (
          <p className="text-[12px] text-ink-faint">None of the supported tools are installed on this machine.</p>
        )}
        {tools?.map((t) => (
          <div
            key={t.id}
            className="flex flex-wrap items-center gap-2 rounded-xl border p-2.5"
            style={{ borderColor: 'var(--line)' }}
          >
            <TerminalIcon className="h-4 w-4 shrink-0 text-ink-faint" />
            <span className="text-[12.5px] font-medium">{t.label}</span>
            {t.installed ? (
              <Badge tone="success" variant="soft">Added</Badge>
            ) : t.detected ? (
              <span className="chip">installed, not added</span>
            ) : (
              <span className="chip">not found</span>
            )}
            <span className="ml-auto flex items-center gap-2">
              <button
                className="text-[11.5px] text-ink-faint hover:text-ink"
                onClick={async () => {
                  const s = await window.nekko.subagentSnippet(t.id).catch(() => null);
                  setSnippet(s ? { ...s, id: t.id } : null);
                }}
              >
                Show snippet
              </button>
              {!t.installed && (
                <button
                  className="btn btn-outline py-1 text-[11.5px]"
                  disabled={installing !== null}
                  onClick={() => install(t.id)}
                >
                  {installing === t.id ? 'Adding…' : 'Add'}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      {snippet && (
        <div>
          <p className="mb-1 text-[11px] text-ink-faint">Paste into {snippet.target}</p>
          <Command value={snippet.snippet} />
        </div>
      )}

      <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
        <p className="mb-1 text-[11.5px] text-ink-soft">
          Anything else that speaks MCP takes this. With the server on it drives this window; without it, a
          separate copy on your data directory.
        </p>
        <Command value={apiServerMcpConfig(url, token || '<start the server to get a token>')} />
        {!running && (
          <p className="mt-1 text-[11px]" style={{ color: 'var(--warning)' }}>
            The server is off, so the two env lines have nothing to reach yet.
          </p>
        )}
      </div>
    </div>
  );
}

function Step({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-soft">
        <span
          className="grid h-4 w-4 place-items-center rounded-full text-[9px] tabular-nums"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          {n}
        </span>
        {label}
      </p>
      {children}
    </div>
  );
}

/** A block of shell or JSON with a copy button, since that is what it is for. */
function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="group relative">
      <pre
        className="max-h-56 overflow-auto rounded-lg p-2.5 pr-9 font-mono text-[11px] leading-relaxed"
        style={{ background: 'var(--surface-2)' }}
      >
        {value}
      </pre>
      <button
        className="absolute right-1.5 top-1.5 rounded-md p-1 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100 focus:opacity-100"
        title="Copy"
        aria-label="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            /* clipboard denied, nothing worth surfacing */
          }
        }}
      >
        {copied ? (
          <span style={{ color: 'var(--success)' }}>
            <CheckIcon className="h-3.5 w-3.5" />
          </span>
        ) : (
          <CopyIcon className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

/** A value that is only useful in someone else's config, one click from there. */
function CopyPill({ value, title, compact = false }: { value: string; title: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-full border ${compact ? 'px-1.5 py-0.5' : 'px-2 py-1'} font-mono text-[11px] text-ink-faint hover:text-ink`}
      style={{ borderColor: 'var(--line)' }}
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          /* clipboard denied */
        }
      }}
    >
      {!compact && value}
      {copied ? (
        <span style={{ color: 'var(--success)' }}>
          <CheckIcon className="h-3 w-3" />
        </span>
      ) : (
        <CopyIcon className="h-3 w-3" />
      )}
    </button>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className="rounded-full px-2.5 py-1 text-[12px]"
      style={
        active
          ? { background: 'color-mix(in srgb, var(--accent) 16%, transparent)', color: 'var(--accent)' }
          : { color: 'var(--ink-faint)' }
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatusDot({ running, busy }: { running: boolean; busy: boolean }) {
  const color = busy ? 'var(--warning)' : running ? 'var(--success)' : 'var(--ink-faint)';
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color, opacity: busy ? 0.7 : 1 }}
      aria-hidden
    />
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-[12px]">{label}</label>
        {children}
      </div>
      <p className="mt-0.5 text-[11px] text-ink-faint">{hint}</p>
    </div>
  );
}
