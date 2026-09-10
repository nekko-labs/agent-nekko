import React, { useEffect, useRef, useState } from 'react';
import type { ChatMode, McpServerStatus, Session } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { WrenchIcon, PlaneIcon, MaskIcon, PlugIcon, PlusIcon } from '../icons.js';

/** Where we point people for hardened, local-first MCP server management. */
const HYPERGATE_URL = 'https://hypergate.app';

/**
 * MCP servers menu, parked just right of Tools in the execution row. Lists every
 * configured MCP server with a live status dot, its name, and an enable/disable
 * toggle; offers "Add MCP server" (jumps to Settings) and recommends Hypergate
 * for managing servers securely. Server enablement is global (in settings), so
 * turning one on offers its tools to every chat.
 */
function McpMenu() {
  const settings = useStore((s) => s.settings);
  const servers = settings?.mcpServers ?? [];
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<McpServerStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Probe live connection status the first time the menu opens (getMcpStatus can
  // spawn/dial servers, so we don't do it on every render).
  useEffect(() => {
    if (!open || status !== null || servers.length === 0) return;
    setChecking(true);
    window.kotrain.getMcpStatus()
      .then(setStatus)
      .catch(() => setStatus([]))
      .finally(() => setChecking(false));
  }, [open, status, servers.length]);

  const enabledCount = servers.filter((s) => s.enabled).length;
  const statusOf = (id: string) => status?.find((s) => s.id === id);

  const toggle = async (id: string) => {
    const next = servers.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s));
    await window.kotrain.updateSettings({ mcpServers: next });
    await useStore.getState().refreshSettings();
    // Config changed: re-probe so the dots reflect the new enablement.
    setStatus(null);
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="ctl-menu whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="MCP servers whose tools are offered to your chats"
      >
        <PlugIcon className="h-3 w-3 text-ink-faint" />
        <span className="ctl-menu-label">MCP</span>
        <span className="tabular-nums">{enabledCount}/{servers.length}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {open && (
        <div className="card absolute bottom-8 left-0 z-40 w-72 p-1.5 shadow-lg" role="menu">
          {servers.length === 0 && (
            <p className="px-2.5 py-2 text-[11px] text-ink-faint">
              No MCP servers yet. Add one to extend every chat with its tools.
            </p>
          )}
          {servers.length > 0 && (
            <div className="max-h-64 overflow-y-auto">
              {servers.map((s) => {
                const st = statusOf(s.id);
                const dot = !s.enabled
                  ? 'var(--ink-faint)'
                  : st
                    ? (st.connected ? 'var(--success)' : 'var(--danger)')
                    : 'var(--warning)';
                const sub = !s.enabled
                  ? (s.url != null ? 'http · off' : 'stdio · off')
                  : st
                    ? (st.connected ? `${s.url != null ? 'http' : 'stdio'} · ${st.tools.length} tools` : (st.error ? `offline · ${st.error}` : 'offline'))
                    : (checking ? 'checking…' : (s.url != null ? 'http' : 'stdio'));
                return (
                  <button
                    key={s.id}
                    role="menuitemcheckbox"
                    aria-checked={s.enabled}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => toggle(s.id)}
                    title={s.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px]">{s.name}</span>
                      <span className="block truncate text-[10.5px] text-ink-faint">{sub}</span>
                    </span>
                    {/* Enable/disable switch */}
                    <span
                      className="relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors"
                      style={{ background: s.enabled ? 'var(--accent)' : 'color-mix(in srgb, var(--ink-faint) 40%, transparent)' }}
                      aria-hidden="true"
                    >
                      <span
                        className="absolute h-3 w-3 rounded-full bg-white shadow-sm transition-transform"
                        style={{ transform: s.enabled ? 'translateX(14px)' : 'translateX(2px)' }}
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-1 border-t border-line pt-1">
            <button
              role="menuitem"
              className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-accent hover:bg-surface-2"
              onClick={() => { setOpen(false); useStore.getState().setView('settings'); }}
            >
              <PlusIcon className="h-3.5 w-3.5" /> Add MCP server
            </button>
            <button
              role="menuitem"
              className="flex w-full items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[11px] text-ink-faint hover:bg-surface-2"
              onClick={() => window.kotrain.openPath(HYPERGATE_URL)}
              title="Hypergate: local-first, secure MCP server management"
            >
              <ShieldSmall />
              <span>Manage servers securely with <span className="font-medium text-ink-soft">Hypergate</span> ↗</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A tiny shield glyph for the Hypergate recommendation row. */
function ShieldSmall() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-accent">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

const MODE_LABEL: Record<ChatMode, string> = { ask: 'Ask', guardrails: 'Guardrails', yolo: 'YOLO' };
const MODE_DESC: Record<ChatMode, string> = {
  ask: 'Confirm every file write and command.',
  guardrails: 'Run freely; ask/deny per guardrail rules.',
  yolo: 'Run everything (deny rules still block).',
};

/**
 * The per-chat execution row of the instrument strip above the composer: how
 * tools run (mode, which tools) on the left, and the two privacy switches
 * (Offline, Incognito) parked on the right behind a hairline divider, so
 * "what this agent may do" reads apart from "what it may reach".
 *
 * The two families look different on purpose: value pickers are bordered fields
 * with a caret (`.ctl-menu`), switches are quiet until hovered and show their
 * on-state with color and a lit dot rather than a filled pill (`.ctl-toggle`).
 */
export function ChatControls({
  session,
  isCloudModel,
  onChange,
}: {
  session: Session | null;
  isCloudModel: boolean;
  onChange: (s: Session | null) => void;
}) {
  const settings = useStore((s) => s.settings);
  const [tools, setTools] = useState<Array<{ name: string; description: string }>>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [toolQuery, setToolQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => { window.kotrain.listTools().then(setTools); }, []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setToolsOpen(false); setModeOpen(false); }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setToolsOpen(false); setModeOpen(false); }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, []);

  if (!session) return null;

  const mode: ChatMode = session.mode ?? settings?.defaultChatMode ?? 'guardrails';
  const disabled = new Set(session.disabledTools ?? []);
  const enabledCount = tools.length - disabled.size;
  const offline = !!session.offline;
  const incognito = !!session.incognito;
  const shownTools = toolQuery.trim()
    ? tools.filter((t) => t.name.toLowerCase().includes(toolQuery.trim().toLowerCase()))
    : tools;

  const patch = async (p: Partial<Session>) => {
    const next = await window.kotrain.setSessionOptions(session.id, p as any);
    onChange(next);
  };

  const toggleTool = (name: string) => {
    const next = new Set(disabled);
    next.has(name) ? next.delete(name) : next.add(name);
    patch({ disabledTools: [...next] });
  };

  return (
    <div ref={ref} className="flex w-full min-w-0 items-center gap-1.5 text-[12px]">
      {/* Mode */}
      <div className="relative shrink-0">
        <button
          className="ctl-menu whitespace-nowrap"
          onClick={() => { setModeOpen((o) => !o); setToolsOpen(false); }}
          aria-haspopup="menu"
          aria-expanded={modeOpen}
          title={MODE_DESC[mode]}
        >
          <span className="ctl-menu-label">Mode</span>
          {MODE_LABEL[mode]}
          <span className="ctl-caret">▾</span>
        </button>
        {modeOpen && (
          <div className="card absolute bottom-8 left-0 z-40 w-60 p-1.5 shadow-lg" role="menu">
            {(['ask', 'guardrails', 'yolo'] as ChatMode[]).map((m) => (
              <button
                key={m}
                role="menuitemradio"
                aria-checked={mode === m}
                className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${mode === m ? 'text-accent' : ''}`}
                onClick={() => { patch({ mode: m }); setModeOpen(false); }}
              >
                <span className="text-[13px] font-medium">{MODE_LABEL[m]}</span>
                <span className="text-[11px] text-ink-faint">{MODE_DESC[m]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tools */}
      <div className="relative shrink-0">
        <button
          className="ctl-menu whitespace-nowrap"
          onClick={() => { setToolsOpen((o) => !o); setModeOpen(false); setToolQuery(''); }}
          disabled={offline}
          aria-haspopup="menu"
          aria-expanded={toolsOpen}
          title={offline ? 'Tools are off in Offline mode' : 'Enable/disable tools for this chat'}
        >
          <WrenchIcon className="h-3 w-3 text-ink-faint" />
          <span className="ctl-menu-label">Tools</span>
          <span className="tabular-nums">{offline ? 'off' : `${enabledCount}/${tools.length}`}</span>
          <span className="ctl-caret">▾</span>
        </button>
        {toolsOpen && !offline && (
          <div className="card absolute bottom-8 left-0 z-40 flex max-h-80 w-64 flex-col p-1.5 shadow-lg">
            {tools.length > 7 && (
              <input
                className="input mb-1 rounded-lg px-2.5 py-1 text-[12px]"
                placeholder="Filter tools…"
                value={toolQuery}
                autoFocus
                aria-label="Filter tools"
                onChange={(e) => setToolQuery(e.target.value)}
              />
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {shownTools.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">No tools match.</p>}
              {shownTools.map((t) => {
                const on = !disabled.has(t.name);
                return (
                  <button
                    key={t.name}
                    className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => toggleTool(t.name)}
                    title={t.description}
                    role="menuitemcheckbox"
                    aria-checked={on}
                  >
                    <span className="mt-0.5 text-[12px]" style={{ color: on ? 'var(--accent)' : 'var(--ink-faint)' }}>{on ? '☑' : '☐'}</span>
                    <span className="min-w-0">
                      <span className="block font-mono text-[12px]">
                        {t.name.startsWith('mcp__') ? `🔌 ${t.name.split('__').slice(2).join('__')}` : t.name}
                      </span>
                      <span className="block truncate text-[11px] text-ink-faint">{t.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* MCP servers, right of Tools: their tools are what the agent can reach. */}
      <McpMenu />

      {/* The privacy switches sit apart from the execution controls: pushed to
          the right edge of the row, behind a hairline. */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <span className="mr-0.5 h-4 w-px bg-line" aria-hidden="true" />

        {/* Offline */}
        <button
          className="ctl-toggle whitespace-nowrap"
          onClick={() => !isCloudModel && patch({ offline: !offline })}
          disabled={isCloudModel}
          aria-pressed={offline}
          title={isCloudModel ? 'Offline mode is only for local models' : 'No tools, no connectors, no internet'}
        >
          <span className="ctl-dot" />
          <PlaneIcon className="h-3 w-3" /> Offline
        </button>

        {/* Incognito */}
        <button
          className="ctl-toggle ctl-toggle-neutral whitespace-nowrap"
          onClick={() => patch({ incognito: !incognito })}
          aria-pressed={incognito}
          title="Don't save this chat or update memory"
        >
          <span className="ctl-dot" />
          <MaskIcon className="h-3 w-3" /> Incognito
        </button>
      </div>
    </div>
  );
}
