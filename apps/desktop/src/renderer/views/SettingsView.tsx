import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, ChatMode, GuardrailRule, GuardrailAction, McpServerStatus, SandboxMode } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { Badge } from '../components/primitives/index.js';
import { UpdateProgress, useUpdater } from '../components/UpdateBanner.js';
import { ThemePresetPicker } from '../components/ThemePresetPicker.js';
import { DEFAULT_SPEC_METHODOLOGY, SPEC_METHODOLOGIES, ORCHESTRATION_STRATEGIES, DEFAULT_ORCHESTRATION, DEFAULT_MAX_STEPS, MAX_STEPS_RANGE, clampMaxSteps, MAX_OUTPUT_TOKENS_DEFAULT, MAX_OUTPUT_TOKENS_RANGE, clampMaxOutputTokens, ONBOARDING_VERSION } from '@agent-nekko/shared';
import { ShieldIcon, SunIcon, TrashIcon, RobotIcon, WandIcon } from '../icons.js';
import { RemoteAccess } from '../components/RemoteAccess.js';
import { useT, LANGUAGES } from '../i18n.js';

const SANDBOX_OPTS: Array<{ value: SandboxMode; label: string; desc: string }> = [
  { value: 'workspace-jail', label: 'Workspace jail', desc: 'File access is confined to your added folders.' },
  { value: 'ask-everything', label: 'Ask everything', desc: 'Every write or command asks for approval.' },
  { value: 'docker', label: 'Docker', desc: 'Run shell commands inside a container if Docker is present.' },
  { value: 'off', label: 'Off', desc: 'No restrictions (power users).' },
];

const ACTION_COLORS: Record<GuardrailAction, string> = { allow: 'var(--success)', ask: 'var(--warning)', deny: 'var(--danger)' };

const CHAT_MODES: Array<{ value: ChatMode; label: string; desc: string }> = [
  { value: 'ask', label: 'Ask', desc: 'Confirm every file write and command before it runs.' },
  { value: 'guardrails', label: 'Guardrails', desc: 'Run freely, but ask/deny per your guardrail rules.' },
  { value: 'yolo', label: 'YOLO', desc: 'Run everything without confirming (deny rules still block).' },
];

export function SettingsView() {
  const { applyTheme, onboardingOpen } = useStore();
  const tr = useT();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const prevOnboardingOpen = useRef(onboardingOpen);

  useEffect(() => { window.kotrain.getSettings().then(setSettings); }, []);

  // When the wizard overlay closes, re-read settings so the Settings view
  // behind it reflects any theme/onboarding changes made inside the wizard.
  useEffect(() => {
    if (prevOnboardingOpen.current && !onboardingOpen) {
      void window.kotrain.getSettings().then(setSettings);
    }
    prevOnboardingOpen.current = onboardingOpen;
  }, [onboardingOpen]);

  const update = async (patch: Partial<AppSettings>) => {
    const next = await window.kotrain.updateSettings(patch);
    setSettings(next);
    useStore.setState({ settings: next });
    applyTheme();
  };

  /** Re-read settings the host changed on its own (connecting Hypergate writes an MCP entry). */
  const reload = useCallback(async () => setSettings(await window.kotrain.getSettings()), []);

  /** Reopen the first-run wizard: clear the completion flag, then show it. */
  const replaySetup = async () => {
    await update({ onboarding: { version: ONBOARDING_VERSION } });
    useStore.getState().setOnboardingOpen(true);
  };

  const updateGuardrail = async (rule: GuardrailRule) => {
    if (!settings) return;
    const guardrails = settings.guardrails.map((g) => (g.id === rule.id ? rule : g));
    update({ guardrails });
  };

  if (!settings) return null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <h1 className="text-2xl font-semibold">{tr('settings.title')}</h1>

        {/* Appearance */}
        <section className="card mt-6 p-5">
          <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">{tr('settings.appearance')}</h2></div>
          <ThemePresetPicker settings={settings} update={update} />
          <div className="mt-2 flex min-h-[40px] items-center justify-between">
            <span className="text-[13px]">{tr('settings.accent')}</span>
            <input type="color" value={settings.accent} onChange={(e) => update({ accent: e.target.value })} className="h-7 w-12 rounded-lg" />
          </div>
          <div className="flex min-h-[40px] items-center justify-between">
            <span className="text-[13px]">{tr('settings.mascot')}</span>
            <Toggle on={settings.mascotEnabled} onChange={(v) => update({ mascotEnabled: v })} />
          </div>
          <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3">
            <div className="min-w-0">
              <span className="text-[13px]">{tr('settings.language')}</span>
              <p className="text-[11px] text-ink-faint">{tr('settings.languageHint')}</p>
            </div>
            <select
              className="input max-w-[180px] py-1.5"
              value={settings.language ?? ''}
              onChange={(e) => update({ language: e.target.value || undefined })}
            >
              <option value="">{tr('settings.systemDefault')}</option>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </div>
          <div className="mt-2 flex min-h-[40px] items-center justify-between gap-3 border-t border-line pt-3">
            <div className="min-w-0">
              <span className="text-[13px]">Setup wizard</span>
              <p className="text-[11px] text-ink-faint">Reopen the first-run walkthrough (theme, providers, integrations).</p>
            </div>
            <button className="btn btn-outline shrink-0 py-1.5 text-[12px]" onClick={() => void replaySetup()}>
              Replay setup
            </button>
          </div>
        </section>

        {/* Updates */}
        <UpdatesSection settings={settings} onToggle={(v) => update({ autoUpdate: v })} />

        {/* Sandbox */}
        <section className="card mt-5 p-5">
          <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">{tr('settings.sandbox')}</h2></div>
          <p className="mt-1 text-[12px] text-ink-faint">How Agent Nekko is allowed to touch your machine.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {SANDBOX_OPTS.map((o) => (
              <button key={o.value} onClick={() => update({ sandboxMode: o.value })} className={`card p-3 text-left ${settings.sandboxMode === o.value ? 'border-accent' : ''}`}>
                <div className="text-[13px] font-medium">{o.label}</div>
                <div className="mt-0.5 text-[11px] text-ink-faint">{o.desc}</div>
              </button>
            ))}
          </div>
        </section>

        {/* Chat modes */}
        <section className="card mt-5 p-5">
          <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">{tr('settings.chatModes')}</h2></div>
          <p className="mt-1 text-[12px] text-ink-faint">
            How chats run tools. Pick the default for new chats, each chat can override it from the composer.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {CHAT_MODES.map((m) => {
              const active = (settings.defaultChatMode ?? 'guardrails') === m.value;
              return (
                <button key={m.value} onClick={() => update({ defaultChatMode: m.value })} className={`card p-3 text-left ${active ? 'border-accent' : ''}`}>
                  <div className="text-[13px] font-medium">{m.label}</div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">{m.desc}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Agent loop */}
        <AgentLoopSection settings={settings} update={update} />

        {/* Spec-driven development */}
        <section className="card mt-5 p-5">
          <div className="flex items-center gap-2"><h2 className="font-semibold">Spec-driven development</h2></div>
          <p className="mt-1 text-[12px] text-ink-faint">
            Default workflow for building a spec and tasks from a conversation. Each chat can override it in the Context panel.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {SPEC_METHODOLOGIES.map((m) => {
              const active = (settings.specMethodology ?? DEFAULT_SPEC_METHODOLOGY) === m.id;
              return (
                <button key={m.id} onClick={() => update({ specMethodology: m.id })} className={`card p-3 text-left ${active ? 'border-accent' : ''}`}>
                  <div className="text-[13px] font-medium">{m.label}</div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">{m.description}</div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Agent orchestration */}
        <section className="card mt-5 p-5">
          <div className="flex items-center gap-2"><RobotIcon className="h-4 w-4" /><h2 className="font-semibold">Agent orchestration</h2></div>
          <p className="mt-1 text-[12px] text-ink-faint">
            How agents delegate to sub-agents. Shapes the system prompt and whether the <code className="text-[11px]">spawn_agent</code> tool is offered.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
            {ORCHESTRATION_STRATEGIES.map((st) => {
              const cur = settings.orchestration ?? DEFAULT_ORCHESTRATION;
              const active = cur.strategy === st.id;
              return (
                <button
                  key={st.id}
                  onClick={() => update({ orchestration: { ...cur, strategy: st.id } })}
                  className={`card p-3 text-left ${active ? 'border-accent' : ''}`}
                >
                  <div className="text-[13px] font-medium">{st.label}</div>
                  <div className="mt-0.5 text-[11px] text-ink-faint">{st.description}</div>
                </button>
              );
            })}
          </div>
          {(settings.orchestration ?? DEFAULT_ORCHESTRATION).strategy !== 'solo' && (
            <div className="mt-3 flex flex-wrap gap-4">
              {([
                { key: 'maxDepth', label: 'Max nesting depth', min: 1, max: 4 },
                { key: 'maxParallel', label: 'Parallel sub-agents (advisory)', min: 1, max: 12 },
              ] as const).map((f) => {
                const cur = settings.orchestration ?? DEFAULT_ORCHESTRATION;
                return (
                  <label key={f.key} className="flex items-center gap-2 text-[12px]">
                    <span className="text-ink-faint">{f.label}</span>
                    <input
                      type="number"
                      min={f.min}
                      max={f.max}
                      value={cur[f.key]}
                      onChange={(e) => {
                        const n = Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.min));
                        update({ orchestration: { ...cur, [f.key]: n } });
                      }}
                      className="input w-16 text-[12px]"
                    />
                  </label>
                );
              })}
            </div>
          )}
        </section>

        {/* Spec-driven development */}

        {/* MCP servers */}
        <McpSection settings={settings} update={update} reload={reload} />

        {/* Remote access (relay) */}
        <RemoteAccess />

        {/* Guardrails */}
        <GuardrailsSection settings={settings} update={update} updateGuardrail={updateGuardrail} />

        {/* Experimental */}
        <section className="card mt-5 p-5">
          <div className="flex items-center gap-2"><WandIcon className="h-4 w-4" /><h2 className="font-semibold">Experimental</h2></div>
          <p className="mt-1 text-[12px] text-ink-faint">
            In-progress surfaces, kept out of the sidebar until you switch them on here. Off by default; turning one off hides the tab again.
          </p>
          <div className="mt-3">
            {([
              { key: 'training', label: 'Model training', desc: 'Show the Training tab: launch and watch data-scientist agent runs.' },
              { key: 'design', label: 'Design board', desc: 'Show the Design tab: sketch or describe a UI and generate live prototypes.' },
              { key: 'memory', label: 'Memory', desc: 'Show the Memory tab: browse and edit global and per-project memory.' },
              { key: 'workflowLoopbackListener', label: 'Workflow loopback listener', desc: 'Listen on 127.0.0.1:1441 for inbound workflow webhooks (desktop only).' },
            ] as const).map((f) => (
              <div key={f.key} className="flex min-h-[40px] items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-[13px]">{f.label}</span>
                  <p className="text-[11px] text-ink-faint">{f.desc}</p>
                </div>
                <Toggle
                  on={settings.experimental?.[f.key] === true}
                  onChange={(v) => update({ experimental: { ...settings.experimental, [f.key]: v } })}
                />
              </div>
            ))}
          </div>
        </section>

        {/* Backup & restore */}
        <BackupSection settings={settings} onSettings={(s) => { setSettings(s); useStore.setState({ settings: s }); applyTheme(); }} />

        {/* Data & privacy */}
        <DataSection onSettings={(s) => { setSettings(s); useStore.setState({ settings: s }); applyTheme(); }} />

        <p className="mt-6 text-center text-[11px] text-ink-faint">Agent Nekko · open source · MIT</p>
      </div>
    </div>
  );
}

/**
 * The agent loop's step budget: how many tool steps one reply may take before
 * Kotrain stops and answers with what it has. Committed on blur/Enter (not per
 * keystroke) so a half-typed number never becomes the live setting.
 */
function AgentLoopSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const savedSteps = settings.maxSteps ?? DEFAULT_MAX_STEPS;
  const [steps, setSteps] = useState(String(savedSteps));
  useEffect(() => { setSteps(String(settings.maxSteps ?? DEFAULT_MAX_STEPS)); }, [settings.maxSteps]);

  const commitSteps = () => {
    const next = clampMaxSteps(Number(steps)) ?? DEFAULT_MAX_STEPS;
    setSteps(String(next));
    if (next !== savedSteps) update({ maxSteps: next });
  };

  const savedOut = clampMaxOutputTokens(settings.maxOutputTokens);
  const [out, setOut] = useState(String(savedOut));
  useEffect(() => { setOut(String(clampMaxOutputTokens(settings.maxOutputTokens))); }, [settings.maxOutputTokens]);

  const commitOut = () => {
    const next = clampMaxOutputTokens(Number(out));
    setOut(String(next));
    if (next !== savedOut) update({ maxOutputTokens: next });
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><RobotIcon className="h-4 w-4" /><h2 className="font-semibold">Agent loop</h2></div>
      <p className="mt-1 text-[12px] text-ink-faint">
        A long task takes many tool steps (read, search, edit, verify). These are the backstops that catch a loop
        going nowhere, not work limits: when a reply reaches one, Agent Nekko stops and answers with what it found plus
        the next steps, so nothing is thrown away.
      </p>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px]">Tool steps per reply</span>
          <p className="text-[11px] text-ink-faint">
            {MAX_STEPS_RANGE.min}–{MAX_STEPS_RANGE.max}. Default {DEFAULT_MAX_STEPS}.
          </p>
        </div>
        <input
          type="number"
          className="input max-w-[110px] py-1.5 tabular-nums"
          min={MAX_STEPS_RANGE.min}
          max={MAX_STEPS_RANGE.max}
          value={steps}
          aria-label="Tool steps per reply"
          onChange={(e) => setSteps(e.target.value)}
          onBlur={commitSteps}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>
      <div className="mt-3 flex min-h-[40px] items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0">
          <span className="text-[13px]">Output cap per response</span>
          <p className="text-[11px] text-ink-faint">
            Tokens one response may generate. Stops a model that gets stuck repeating itself from streaming until
            its context fills. {MAX_OUTPUT_TOKENS_RANGE.min}–{MAX_OUTPUT_TOKENS_RANGE.max.toLocaleString()}. Default{' '}
            {MAX_OUTPUT_TOKENS_DEFAULT.toLocaleString()}.
          </p>
        </div>
        <input
          type="number"
          className="input max-w-[110px] py-1.5 tabular-nums"
          min={MAX_OUTPUT_TOKENS_RANGE.min}
          max={MAX_OUTPUT_TOKENS_RANGE.max}
          step={256}
          value={out}
          aria-label="Output cap per response"
          onChange={(e) => setOut(e.target.value)}
          onBlur={commitOut}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        />
      </div>
    </section>
  );
}

function BackupSection({ settings, onSettings }: { settings: AppSettings; onSettings: (s: AppSettings) => void }) {
  const { pushToast, refreshProviders } = useStore();

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kotrain-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Not a settings object');
        if (!window.confirm('Import these settings? This overwrites your current configuration.')) return;
        const next = await window.kotrain.updateSettings(parsed);
        onSettings(next);
        await refreshProviders();
        pushToast('success', 'Settings imported.');
      } catch (e) {
        pushToast('error', `Import failed: ${(e as Error).message}`);
      }
    };
    input.click();
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">Backup &amp; restore</h2></div>
      <p className="mt-1 text-[12px] text-ink-faint">Export your configuration (providers, guardrails, prompts, MCP servers…) to a JSON file, or restore it on another machine.</p>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-outline py-1.5 text-[12px]" onClick={exportSettings}>Export settings</button>
        <button className="btn btn-outline py-1.5 text-[12px]" onClick={importSettings}>Import settings…</button>
      </div>
    </section>
  );
}

function DataSection({ onSettings }: { onSettings: (s: AppSettings) => void }) {
  const { refreshSessions, refreshProviders, pushToast } = useStore();
  const [busy, setBusy] = useState(false);

  const clear = async (scope: 'today' | 'month' | 'all', label: string) => {
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return;
    setBusy(true);
    const n = await window.kotrain.clearSessions(scope);
    await refreshSessions();
    useStore.setState({ activeSessionId: null });
    setBusy(false);
    pushToast('success', `Deleted ${n} chat${n === 1 ? '' : 's'}.`);
  };

  const reset = async () => {
    if (!window.confirm('Reset all settings to defaults? Your providers and preferences will be cleared (chats are kept).')) return;
    setBusy(true);
    const s = await window.kotrain.resetSettings();
    onSettings(s);
    await refreshProviders();
    setBusy(false);
    pushToast('success', 'Settings reset to defaults.');
  };

  const wipe = async () => {
    if (!window.confirm('Delete EVERYTHING, all chats, settings, memory, and usage? This cannot be undone.')) return;
    if (!window.confirm('Are you absolutely sure? This wipes all Agent Nekko data.')) return;
    setBusy(true);
    const s = await window.kotrain.wipeAllData();
    onSettings(s);
    await refreshSessions();
    await refreshProviders();
    useStore.setState({ activeSessionId: null });
    setBusy(false);
    pushToast('success', 'All data deleted.');
  };

  return (
    <section className="card mt-5 p-5" style={{ borderColor: 'color-mix(in srgb, var(--danger) 35%, var(--line))' }}>
      <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">Data &amp; privacy</h2></div>
      <p className="mt-1 text-[12px] text-ink-faint">Everything stays on your machine. Clean it up here whenever you want.</p>

      <div className="mt-3 flex min-h-[36px] flex-wrap items-center justify-between gap-2">
        <span className="text-[13px]">Delete chats</span>
        <div className="flex flex-wrap gap-2">
          <button className="btn btn-outline py-1.5 text-[12px]" disabled={busy} onClick={() => clear('today', "today's chats")}>Today</button>
          <button className="btn btn-outline py-1.5 text-[12px]" disabled={busy} onClick={() => clear('month', "this month's chats")}>This month</button>
          <button className="btn btn-outline py-1.5 text-[12px]" disabled={busy} onClick={() => clear('all', 'all chats')}>All chats</button>
        </div>
      </div>

      <div className="mt-2 flex min-h-[36px] items-center justify-between gap-2">
        <span className="text-[13px]">Reset settings to defaults</span>
        <button className="btn btn-outline py-1.5 text-[12px]" disabled={busy} onClick={reset}>Reset configs</button>
      </div>

      <div className="mt-2 flex min-h-[36px] items-center justify-between gap-2">
        <div>
          <span className="text-[13px]">Delete everything</span>
          <p className="text-[11px] text-ink-faint">Chats, settings, memory, and usage analytics.</p>
        </div>
        <button
          className="btn py-1.5 text-[12px] text-white!"
          style={{ background: 'var(--danger)' }}
          disabled={busy}
          onClick={wipe}
        >
          Delete everything
        </button>
      </div>
    </section>
  );
}

function McpSection({
  settings, update, reload,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reload: () => Promise<void>;
}) {
  const { pushToast } = useStore();
  const servers = settings.mcpServers ?? [];
  const [status, setStatus] = useState<McpServerStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [linking, setLinking] = useState(false);
  // The local Hypergate daemon, if one is running: undefined while probing,
  // null when nothing answered. Lives in the store because the pairing is
  // app-wide (the tab, the palette, and the deep link all read it).
  const hypergate = useStore((s) => s.hypergate);
  const refreshHypergate = useStore((s) => s.refreshHypergate);
  const connectHypergate = useStore((s) => s.connectHypergate);
  const openHypergatePane = useStore((s) => s.openHypergatePane);
  useEffect(() => { void refreshHypergate(); }, [refreshHypergate]);
  // The gateway keeps a fixed id, so "is it connected" is a lookup rather than
  // something to track. The pre-rename id counts: that row is the same gateway.
  const connected = servers.some((s) => s.id === 'hypergate' || s.id === 'kotrain-mcp');
  /** One click: claim a token, save the entry, connect it, open the tab. */
  const link = async () => {
    setLinking(true);
    if (await connectHypergate(hypergate?.port)) await reload();
    setLinking(false);
  };
  const setServers = (next: typeof servers) => update({ mcpServers: next });
  const add = () =>
    setServers([
      ...servers,
      { id: `m_${Date.now().toString(36)}`, name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '.'], enabled: false },
    ]);
  const addUrl = () =>
    setServers([
      ...servers,
      { id: `m_${Date.now().toString(36)}`, name: 'http server', command: '', args: [], url: 'http://localhost:7777/mcp', token: '', enabled: false },
    ]);
  const edit = (id: string, patch: Partial<(typeof servers)[number]>) =>
    setServers(servers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => setServers(servers.filter((s) => s.id !== id));
  const connect = async () => {
    setBusy(true);
    try {
      const st = await window.kotrain.getMcpStatus();
      setStatus(st);
      const tools = st.reduce((n, s) => n + s.tools.length, 0);
      pushToast('success', `Connected ${st.filter((s) => s.connected).length}/${st.length} server(s), ${tools} tool(s).`);
    } catch (e) {
      pushToast('error', (e as Error).message);
    }
    setBusy(false);
  };
  const stOf = (id: string) => status.find((s) => s.id === id);

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">MCP servers</h2></div>
        <div className="flex gap-2">
          <button className="btn btn-outline py-1 text-[12px]" onClick={connect} disabled={busy || servers.length === 0}>
            {busy ? 'Connecting…' : 'Connect & refresh'}
          </button>
          <button className="btn btn-outline py-1 text-[12px]" onClick={add}>+ Add</button>
          <button className="btn btn-outline py-1 text-[12px]" onClick={addUrl} title="A streamable-HTTP MCP endpoint (URL + optional bearer token)">+ Add URL</button>
        </div>
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">
        Model Context Protocol servers extend the agent with extra tools. Enabled servers' tools are offered in every chat.
      </p>
      {hypergate && (
        <div className="card mt-3 p-3" style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' }}>
          <div className="flex items-center gap-2">
            <ShieldIcon className="h-5 w-5 shrink-0 text-accent" />
            {/* min-w-0 so the prose is what gives way when the card narrows;
                without it the buttons are squeezed and their labels wrap. */}
            <div className="min-w-0">
              <p className="text-[12.5px] font-semibold">
                Hypergate detected{' '}
                <span className="font-normal text-ink-faint">
                  · v{hypergate.version} · {hypergate.servers} managed server{hypergate.servers === 1 ? '' : 's'} · port {hypergate.port}
                </span>
              </p>
              <p className="text-[11.5px] text-ink-faint">
                {connected
                  ? `Connected${hypergate.agent ? ` as ${hypergate.agent}` : ''}. Every server it manages is one entry here, and its tools are in every chat.`
                  : 'One click registers Agent Nekko with it, adds the gateway below, and opens Hypergate as a tab in this window.'}
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap">
              {connected && (
                <button className="btn btn-outline py-1 text-[12px]" onClick={openHypergatePane}>Open tab</button>
              )}
              <button className="btn btn-primary py-1 text-[12px]" disabled={linking} onClick={() => void link()}>
                {linking ? 'Connecting…' : connected ? 'Reconnect' : 'Connect Hypergate'}
              </button>
            </div>
          </div>
        </div>
      )}
      {hypergate === null && (
        <div className="mt-3 flex items-center gap-2 rounded-xl border border-line px-3 py-2">
          <ShieldIcon className="h-5 w-5 shrink-0 text-ink-faint" />
          <p className="text-[11.5px] text-ink-faint">
            Optional: <span className="font-medium text-ink-soft">Hypergate</span> runs and supervises local MCP servers behind one
            endpoint. Start its daemon and a one-click Connect appears here{connected ? ' (the saved gateway reconnects on its own)' : ''}.
          </p>
          <button
            className="btn btn-ghost ml-auto shrink-0 px-2! py-0.5! text-[11px] text-accent"
            onClick={() => window.kotrain.openPath('https://hypergate.app')}
          >
            Get Hypergate ↗
          </button>
        </div>
      )}
      <div className="mt-3 space-y-2">
        {servers.length === 0 && <p className="text-[12px] text-ink-faint">No MCP servers. Add one (e.g. <code>npx -y @modelcontextprotocol/server-filesystem .</code>).</p>}
        {servers.map((s) => {
          const st = stOf(s.id);
          return (
            <div key={s.id} className={`card p-3 ${s.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-2">
                <input className="input py-1 text-[12.5px]" style={{ maxWidth: 160 }} value={s.name} onChange={(e) => edit(s.id, { name: e.target.value })} />
                <span className="chip">{s.url != null ? 'http' : 'stdio'}</span>
                {st && (
                  <Badge tone={st.connected ? 'success' : 'danger'} variant="solid" title={st.error}>
                    {st.connected ? `${st.tools.length} tools` : 'offline'}
                  </Badge>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <Toggle on={s.enabled} onChange={(v) => edit(s.id, { enabled: v })} />
                  <button className="btn btn-ghost px-2 py-1" title="Remove" onClick={() => remove(s.id)}><TrashIcon className="h-4 w-4" /></button>
                </div>
              </div>
              {s.url != null ? (
                <div className="mt-2 flex gap-2">
                  <input className="input py-1 font-mono text-[12px]" value={s.url} onChange={(e) => edit(s.id, { url: e.target.value })} placeholder="http://localhost:7777/mcp" />
                  <input className="input py-1 font-mono text-[12px]" style={{ maxWidth: 200 }} type="password" value={s.token ?? ''} onChange={(e) => edit(s.id, { token: e.target.value })} placeholder="bearer token (optional)" />
                </div>
              ) : (
                <div className="mt-2 flex gap-2">
                  <input className="input py-1 font-mono text-[12px]" style={{ maxWidth: 110 }} value={s.command} onChange={(e) => edit(s.id, { command: e.target.value })} placeholder="npx" />
                  <input className="input py-1 font-mono text-[12px]" value={s.args.join(' ')} onChange={(e) => edit(s.id, { args: e.target.value.split(/\s+/).filter(Boolean) })} placeholder="-y @modelcontextprotocol/server-filesystem ." />
                </div>
              )}
              {st?.error && <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>{st.error}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function PromptsSection({ settings, update }: { settings: AppSettings; update: (patch: Partial<AppSettings>) => void }) {
  const prompts = settings.prompts ?? [];
  const setPrompts = (next: typeof prompts) => update({ prompts: next });
  const add = () =>
    setPrompts([...prompts, { id: `p_${Date.now().toString(36)}`, name: 'new', body: '' }]);
  const edit = (id: string, patch: Partial<{ name: string; body: string }>) =>
    setPrompts(prompts.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const remove = (id: string) => setPrompts(prompts.filter((p) => p.id !== id));

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">Slash commands</h2></div>
        <button className="btn btn-outline py-1 text-[12px]" onClick={add}>+ Add</button>
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">Reusable prompts. Type <code>/name</code> in the composer to insert one.</p>
      <div className="mt-3 space-y-2">
        {prompts.length === 0 && <p className="text-[12px] text-ink-faint">No prompts yet.</p>}
        {prompts.map((p) => (
          <div key={p.id} className="card p-3">
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-ink-faint">/</span>
              <input
                className="input py-1 text-[12.5px]"
                style={{ maxWidth: 180 }}
                value={p.name}
                onChange={(e) => edit(p.id, { name: e.target.value.replace(/\s+/g, '-') })}
              />
              <button className="btn btn-ghost px-2 py-1" title="Delete" onClick={() => remove(p.id)}>
                <TrashIcon className="h-4 w-4" />
              </button>
            </div>
            <textarea
              className="input mt-2 min-h-[56px] resize-none text-[12.5px]"
              value={p.body}
              placeholder="Prompt text inserted when you pick this command…"
              onChange={(e) => edit(p.id, { body: e.target.value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function GuardrailsSection({
  settings,
  update,
  updateGuardrail,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  updateGuardrail: (rule: GuardrailRule) => void;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const openJson = () => {
    setDraft(JSON.stringify(settings.guardrails, null, 2));
    setError('');
    setJsonMode(true);
  };

  const apply = () => {
    try {
      const parsed = JSON.parse(draft) as GuardrailRule[];
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of rules.');
      for (const r of parsed) {
        if (!r.id || !r.pattern || !r.action) throw new Error('Each rule needs id, pattern, and action.');
      }
      update({ guardrails: parsed });
      setJsonMode(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><ShieldIcon className="h-4 w-4" /><h2 className="font-semibold">Guardrails</h2></div>
        <button className="btn btn-outline py-1 text-[12px]" onClick={() => (jsonMode ? setJsonMode(false) : openJson())}>
          {jsonMode ? 'Visual editor' : 'Edit as JSON'}
        </button>
      </div>
      <p className="mt-1 text-[12px] text-ink-faint">
        Protections for risky commands. Set each to allow, ask, or deny, or edit the rule set directly as JSON.
      </p>

      {jsonMode ? (
        <div className="mt-3">
          <textarea
            className="input min-h-[260px] font-mono text-[12px] leading-relaxed"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
          />
          {error && <p className="mt-1.5 text-[12px]" style={{ color: 'var(--danger)' }}>{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setJsonMode(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={apply}>Apply</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {settings.guardrails.map((g) => (
            <div key={g.id} className={`card p-3 ${g.enabled ? '' : 'opacity-50'}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-medium">{g.label}</span>
                    <span className="h-2 w-2 rounded-full" style={{ background: g.severity === 'high' ? 'var(--danger)' : g.severity === 'medium' ? 'var(--warning)' : 'var(--neutral)' }} />
                  </div>
                  <p className="truncate text-[11px] text-ink-faint">{g.description}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <div className="flex rounded-lg p-0.5" style={{ background: 'var(--surface-2)' }}>
                    {(['allow', 'ask', 'deny'] as GuardrailAction[]).map((a) => (
                      <button
                        key={a}
                        onClick={() => updateGuardrail({ ...g, action: a })}
                        className="rounded-md px-2 py-1 text-[11px] font-medium"
                        style={g.action === a ? { background: ACTION_COLORS[a], color: '#fff' } : { color: 'var(--ink-faint)' }}
                      >
                        {a}
                      </button>
                    ))}
                  </div>
                  <Toggle on={g.enabled} onChange={(v) => updateGuardrail({ ...g, enabled: v })} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function UpdatesSection({ settings, onToggle }: { settings: AppSettings; onToggle: (v: boolean) => void }) {
  const updater = useUpdater();
  const { app: info, info: status, stage } = updater;
  const isWeb = info?.edition === 'web';
  const statusText = stage === 'available'
    ? isWeb ? 'A newer build is ready.' : `Update available: v${status?.version ?? ''}`
    : stage === 'downloaded'
      ? `Ready to install v${status?.version ?? ''}.`
      : stage === 'downloading'
        ? `Downloading v${status?.version ?? ''}`
        : stage === 'installing'
          ? `Installing v${status?.version ?? ''} and restarting.`
          : stage === 'installed'
            ? `Updated to v${info?.version ?? ''}.`
            : stage === 'failed'
              ? updater.error ?? 'Update failed.'
              : status?.state === 'none' && !status.message
                ? "You're up to date."
                : status?.message ?? '';

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center gap-2"><SunIcon className="h-4 w-4" /><h2 className="font-semibold">Updates</h2></div>
      <p className="mt-1 text-[12px] text-ink-faint">
        {info ? `Agent Nekko ${info.version} · ${info.edition} edition` : ' '}
      </p>
      <div className="mt-3 flex min-h-[40px] items-center justify-between">
        <div>
          <span className="text-[13px]">Check for updates automatically</span>
          <p className="text-[11px] text-ink-faint">Connects to the internet to look for new versions.</p>
        </div>
        <Toggle on={!!settings.autoUpdate} onChange={onToggle} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="btn btn-outline py-1.5 text-[12px]" onClick={() => void updater.check(true)} disabled={stage === 'checking' || stage === 'downloading' || stage === 'installing'}>
          {stage === 'checking' ? 'Checking…' : 'Check now'}
        </button>
        {stage === 'available' && (isWeb ? (
          <button className="btn btn-primary py-1.5 text-[12px]" onClick={() => void updater.install()}>Refresh now</button>
        ) : (
          <>
            <button className="btn btn-primary py-1.5 text-[12px]" onClick={() => void updater.downloadAndInstall()}>Download &amp; install</button>
            <button className="btn btn-outline py-1.5 text-[12px]" onClick={() => void updater.downloadOnly()}>Download only</button>
            <button className="btn btn-ghost py-1.5 text-[12px]" onClick={updater.skip}>Skip</button>
          </>
        ))}
        {stage === 'downloaded' && (
          <>
            <button className="btn btn-primary py-1.5 text-[12px]" onClick={() => void updater.install()}>Install &amp; restart</button>
            <button className="btn btn-ghost py-1.5 text-[12px]" onClick={updater.skip}>Skip</button>
          </>
        )}
        {stage === 'failed' && <button className="btn btn-outline py-1.5 text-[12px]" onClick={() => void updater.retry()}>Retry</button>}
        {statusText && <span className={`text-[12px] ${stage === 'failed' ? 'text-danger' : 'text-ink-faint'}`} role="status" aria-live="polite">{statusText}</span>}
      </div>
      {(stage === 'downloading' || stage === 'installing') && (
        <div className="mt-3 flex max-w-md items-center gap-3">
          <UpdateProgress percent={status?.percent} installing={stage === 'installing'} />
          <span className="min-w-10 text-right text-[11px] tabular-nums text-ink-faint">
            {stage === 'downloading' ? `${status?.percent ?? 0}%` : 'restarting'}
          </span>
        </div>
      )}
    </section>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
      style={{ background: on ? 'var(--accent)' : 'var(--line)' }}
    >
      <span
        className="inline-block h-5 w-5 rounded-full bg-white shadow-xs transition-transform"
        style={{ transform: on ? 'translateX(22px)' : 'translateX(2px)' }}
      />
    </button>
  );
}
