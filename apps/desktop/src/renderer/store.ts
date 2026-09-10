import { create } from 'zustand';
import type { AppSettings, Session, ProviderConfig, ModelInfo, TerminalInfo, InstalledSkillRecord, SkillDef, PrInfo, HypergateInfo } from '@agent-nekko/shared';
import { getMarketSkill, marketToSkillDef, normalizeInstallTarget, THEME_PRESETS } from '@agent-nekko/shared';
import type { MascotMood } from './components/Mascot.js';
import { syncTitleBarOverlay } from './chrome.js';

export type View = 'command' | 'chat' | 'models' | 'connectors' | 'memory' | 'settings' | 'design' | 'skills' | 'training' | 'workflows';

/**
 * Nav destinations that live behind a Settings → Experimental toggle. The flag
 * names deliberately match the view ids so `settings.experimental[v]` reads
 * directly.
 */
export const EXPERIMENTAL_VIEWS = ['training', 'design', 'memory'] as const;
export type ExperimentalView = (typeof EXPERIMENTAL_VIEWS)[number];

/**
 * Whether a nav destination is reachable. Experimental views need their flag
 * on; everything else is always available. Settings that haven't loaded yet
 * count as all-flags-off.
 */
export function viewEnabled(view: View, settings: AppSettings | null | undefined): boolean {
  if (!(EXPERIMENTAL_VIEWS as readonly string[]).includes(view)) return true;
  return settings?.experimental?.[view as ExperimentalView] === true;
}

/**
 * Should the setup wizard open itself once settings load?
 *
 * `onboarding.completedAt` is unset on every install that predates the
 * wizard, so gating on the flag alone would ambush existing users with a
 * full-screen takeover on upgrade. A configured provider is the strongest
 * "setup already happened" signal we have, so the wizard auto-opens only on a
 * genuinely fresh install; everyone else can reach it from Settings → Replay
 * setup.
 */
export function shouldAutoOpenOnboarding(settings: AppSettings | null | undefined): boolean {
  if (!settings || settings.onboarding?.completedAt) return false;
  return (settings.providers?.length ?? 0) === 0;
}

/** A message routed into a chat's composer from another surface (editor comment, design note). */
export interface ComposerInbox {
  sessionId: string;
  text: string;
  /** true = send immediately ("Run now"); false = drop into the draft ("Add to prompt"). */
  run: boolean;
}

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'success';
  message: string;
}

/** A single workbench tab: a chat, terminal, file, browser, diff, PR, or Hypergate view. */
export interface WbPane {
  id: string;
  kind: 'chat' | 'terminal' | 'file' | 'browser' | 'diff' | 'pr' | 'hypergate';
  /**
   * What the pane points at: sessionId (chat/diff), terminalId (terminal),
   * absolute file path (file), URL (browser), PR URL (pr), or the Hypergate
   * manager's URL (hypergate).
   */
  refId: string;
}

/** A column of tabbed panes; multiple groups sit side by side. */
export interface WbGroup {
  id: string;
  panes: WbPane[];
  activeId: string | null;
}

const MAX_GROUPS = 3;
let paneSeq = 0;
const newPaneId = () => `pane_${(++paneSeq).toString(36)}`;
const newGroupId = () => `grp_${(++paneSeq).toString(36)}`;

interface UiState {
  settings: AppSettings | null;
  view: View;
  sessions: Session[];
  activeSessionId: string | null;
  providers: ProviderConfig[];
  models: ModelInfo[];
  activeProviderId: string | null;
  activeModelId: string | null;
  contextPanelOpen: boolean;
  /** Whether the first-run setup wizard is showing over the app. */
  onboardingOpen: boolean;
  /** True after the first settings load has finished. */
  settingsLoaded: boolean;
  mascotMood: MascotMood;
  toasts: Toast[];
  paletteOpen: boolean;
  activeWorkspaceId: string | null;

  /**
   * Where the chat's full monitoring section sits on screen (null when it isn't
   * mounted). The floating monitor chip reads this so it can fly into the
   * section instead of covering it.
   */
  monitorDockRect: { x: number; y: number; w: number; h: number } | null;
  setMonitorDockRect: (r: { x: number; y: number; w: number; h: number } | null) => void;

  // Workbench: tabbed, splittable panes (chats + terminals) and live terminals.
  terminals: TerminalInfo[];
  groups: WbGroup[];
  activeGroupId: string | null;

  /** Pending message to hand a chat's composer (set by editor comments / design notes). */
  composerInbox: ComposerInbox | null;

  /**
   * The Hypergate daemon on this machine: `undefined` while we're still
   * probing, `null` when nothing is listening.
   *
   * Kept in the store rather than in Settings' local state because the pairing
   * is app-wide: the sidebar offers the tab, the command palette connects, and
   * a `kotrain://` deep link can arrive with no view mounted at all.
   */
  hypergate: HypergateInfo | null | undefined;
  /** Re-probe for the daemon. Cheap and side-effect free; safe to call on a timer. */
  refreshHypergate: (port?: number) => Promise<void>;
  /**
   * Connect this install to Hypergate and open its tab: one path for the
   * Settings button, the command palette, and the deep link Hypergate itself
   * fires. Resolves false when no daemon answered.
   */
  connectHypergate: (port?: number) => Promise<boolean>;

  /** Live PR state per chat (PRs referenced in its transcript), for cards + badges. */
  prsBySession: Record<string, PrInfo[]>;
  /** Fetch a chat's PRs (gh/API, host-cached) and stash them for cards + badges. */
  refreshSessionPrs: (sessionId: string) => Promise<void>;
  /** Open a PR's diff in a workbench pane. */
  openPrPane: (url: string) => void;

  /** Marketplace installs (all targets) + the Kotrain ones as runnable skills. */
  installedSkills: InstalledSkillRecord[];
  installedSkillDefs: SkillDef[];
  refreshSkills: () => Promise<void>;

  /** The skill armed in each chat's composer (highlighted pill, runs on send). */
  activeSkillBySession: Record<string, SkillDef | null>;
  setActiveSkill: (sessionId: string, skill: SkillDef | null) => void;

  /**
   * What's typed but unsent in each chat's composer. The pane owns the text;
   * this mirror exists so the Context Inspector on the right can count the
   * draft's tokens while you type (the host's context bundle only knows about
   * sent messages).
   */
  draftBySession: Record<string, string>;
  setSessionDraft: (sessionId: string, text: string) => void;

  setActiveWorkspace: (id: string | null) => void;
  pushToast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
  newChat: () => Promise<void>;
  setMascotMood: (m: MascotMood) => void;
  setView: (v: View) => void;
  setOnboardingOpen: (open: boolean) => void;
  refreshSettings: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  setActiveSession: (id: string | null) => void;
  refreshProviders: () => Promise<void>;
  selectProvider: (id: string) => Promise<void>;
  selectModel: (id: string) => void;
  toggleContextPanel: () => void;
  applyTheme: () => void;

  refreshTerminals: () => Promise<void>;
  newTerminal: (workspaceId?: string, shell?: string) => Promise<void>;
  openChatPane: (sessionId: string) => void;
  openTerminalPane: (terminalId: string) => void;
  openFilePane: (path: string) => void;
  openBrowserPane: (url?: string) => void;
  /** Open (or focus) the Hypergate manager as a tab in this window. */
  openHypergatePane: () => void;
  /** Route text to a chat's composer, Add to prompt (run=false) or Run now (run=true). */
  sendToChat: (text: string, run: boolean) => Promise<void>;
  /** Open the diff/approve review for a session's changed files. */
  openDiffPane: (sessionId: string) => void;
  closePane: (groupId: string, paneId: string) => void;
  setActivePane: (groupId: string, paneId: string) => void;
  focusGroup: (groupId: string) => void;
  splitRight: (groupId: string, paneId: string) => void;

  // Sidebar drag-and-drop: persist project order and per-project item order.
  reorderWorkspaces: (orderedIds: string[]) => Promise<void>;
  layoutChats: (targetWorkspaceId: string | undefined, orderedIds: string[], moveId: string | null) => Promise<void>;
  layoutTerminals: (targetWorkspaceId: string | undefined, orderedIds: string[], moveId: string | null) => Promise<void>;
}

/** Find an existing pane for a chat/terminal ref across all groups. */
function locatePane(groups: WbGroup[], kind: WbPane['kind'], refId: string): { groupId: string; paneId: string } | null {
  for (const g of groups) {
    const p = g.panes.find((x) => x.kind === kind && x.refId === refId);
    if (p) return { groupId: g.id, paneId: p.id };
  }
  return null;
}

/** Add a pane to the focused group (creating the first group if needed). */
function addPane(groups: WbGroup[], activeGroupId: string | null, pane: WbPane): { groups: WbGroup[]; activeGroupId: string } {
  if (groups.length === 0) {
    const g: WbGroup = { id: newGroupId(), panes: [pane], activeId: pane.id };
    return { groups: [g], activeGroupId: g.id };
  }
  const gid = activeGroupId && groups.some((g) => g.id === activeGroupId) ? activeGroupId : groups[0].id;
  return {
    groups: groups.map((g) => (g.id === gid ? { ...g, panes: [...g.panes, pane], activeId: pane.id } : g)),
    activeGroupId: gid,
  };
}

export const useStore = create<UiState>((set, get) => ({
  settings: null,
  view: 'command',
  sessions: [],
  activeSessionId: null,
  providers: [],
  models: [],
  activeProviderId: null,
  activeModelId: null,
  // Default the context panel closed on small screens (phones).
  contextPanelOpen: typeof window !== 'undefined' ? window.innerWidth >= 1024 : true,
  onboardingOpen: false,
  settingsLoaded: false,
  mascotMood: 'waving',
  toasts: [],
  paletteOpen: false,
  activeWorkspaceId: null,
  terminals: [],
  groups: [],
  activeGroupId: null,
  prsBySession: {},
  composerInbox: null,

  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  pushToast: (kind, message) => {
    const id = `t_${Date.now().toString(36)}_${Math.floor(performance.now())}`;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  monitorDockRect: null,
  setMonitorDockRect: (r) =>
    set((s) => {
      const p = s.monitorDockRect;
      // The dock reports on every resize; skip no-op writes so the chip's warp
      // transform isn't recomputed for nothing.
      if (p === r || (p && r && p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h)) return s;
      return { monitorDockRect: r };
    }),
  newChat: async () => {
    const s = await window.kotrain.createSession(get().activeWorkspaceId ?? undefined);
    await get().refreshSessions();
    set({ activeSessionId: s.id, view: 'chat' });
    get().openChatPane(s.id);
  },
  setMascotMood: (m) => set({ mascotMood: m }),
  // A destination that's been hidden can't be navigated to: land on the
  // Command Center instead of a dead end.
  setView: (v) => set((s) => ({ view: viewEnabled(v, s.settings) ? v : 'command' })),
  setOnboardingOpen: (open) => set({ onboardingOpen: open }),

  refreshSettings: async () => {
    try {
      const settings = await window.kotrain.getSettings();
      const onboardingOpen = shouldAutoOpenOnboarding(settings);
      set({ settings, onboardingOpen, settingsLoaded: true });
      get().applyTheme();
      if (!get().activeProviderId && settings.defaultProviderId) {
        set({ activeProviderId: settings.defaultProviderId, activeModelId: settings.defaultModelId ?? null });
      }
      if (!get().activeWorkspaceId && settings.workspaces?.[0]) {
        set({ activeWorkspaceId: settings.workspaces[0].id });
      }
    } catch {
      // Never leave the app on the loading gate: if settings can't be read,
      // unblock the UI and let surfaces fall back to their empty states.
      set({ settingsLoaded: true });
    }
  },

  refreshSessions: async () => {
    const sessions = await window.kotrain.listSessions();
    set({ sessions });
    if (!get().activeSessionId && sessions[0]) set({ activeSessionId: sessions[0].id });
  },

  installedSkills: [],
  installedSkillDefs: [],
  refreshSkills: async () => {
    try {
      const installedSkills = await window.kotrain.listInstalledSkills();
      const installedSkillDefs = installedSkills
        .filter((r) => normalizeInstallTarget(r.target) === 'agent-nekko')
        // Vaizer (non-catalog) installs carry their own snapshot on the record.
        .map((r) => r.skill ?? getMarketSkill(r.skillId))
        .filter((m): m is NonNullable<typeof m> => !!m)
        .map(marketToSkillDef);
      set({ installedSkills, installedSkillDefs });
    } catch {
      /* older host without the marketplace channels */
    }
  },

  activeSkillBySession: {},
  setActiveSkill: (sessionId, skill) =>
    set((s) => ({ activeSkillBySession: { ...s.activeSkillBySession, [sessionId]: skill } })),

  draftBySession: {},
  setSessionDraft: (sessionId, text) =>
    set((s) => (s.draftBySession[sessionId] === text
      ? s
      : { draftBySession: { ...s.draftBySession, [sessionId]: text } })),

  setActiveSession: (id) => set({ activeSessionId: id }),

  refreshProviders: async () => {
    const providers = await window.kotrain.listProviders();
    set({ providers });
    const active = get().activeProviderId ?? providers[0]?.id ?? null;
    if (active) {
      set({ activeProviderId: active });
      // Always populate models for the active provider on startup, guards a
      // race where a saved default provider is already active and would
      // otherwise never have its model list fetched.
      if (get().models.length === 0) await get().selectProvider(active);
    }
  },

  selectProvider: async (id) => {
    set({ activeProviderId: id, models: [] });
    const models = await window.kotrain.listModels(id);
    set({ models });
    // Keep the current model if this provider serves it, otherwise leave it
    // unset: a chat then asks which model to use instead of inheriting a guess.
    // Picking the provider's first model (as this used to) is worse than asking,
    // because a local server lists more than chat models - LM Studio's first
    // entry is often `whisper-large-v3`, which can't answer a chat turn at all.
    if (!models.some((m) => m.id === get().activeModelId)) set({ activeModelId: null });
    // Remember as the default for new chats and next launch.
    const activeModelId = get().activeModelId;
    window.kotrain.updateSettings({ defaultProviderId: id, ...(activeModelId ? { defaultModelId: activeModelId } : {}) });
  },

  selectModel: (id) => {
    set({ activeModelId: id });
    window.kotrain.updateSettings({ defaultProviderId: get().activeProviderId ?? undefined, defaultModelId: id });
  },

  toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),

  applyTheme: () => {
    const settings = get().settings;
    const theme = settings?.theme ?? 'system';
    const resolved =
      theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : theme;
    const root = document.documentElement;
    root.setAttribute('data-theme', resolved);

    const presetId = settings?.themePreset;
    if (presetId) root.setAttribute('data-preset', presetId);
    else root.removeAttribute('data-preset');
    const preset = presetId ? THEME_PRESETS.find((p) => p.id === presetId) : undefined;

    if (settings?.accent) root.style.setProperty('--accent', settings.accent);
    else if (preset) root.style.setProperty('--accent', preset.accent);
    else root.style.removeProperty('--accent');

    if (settings?.accent2) root.style.setProperty('--accent-2', settings.accent2);
    else if (preset?.accent2) root.style.setProperty('--accent-2', preset.accent2);
    else root.style.removeProperty('--accent-2');

    // The native window buttons sit in our title bar, so they have to follow
    // the theme with everything else.
    syncTitleBarOverlay();
  },

  refreshTerminals: async () => {
    try {
      set({ terminals: await window.kotrain.listTerminals() });
    } catch {
      /* terminals unsupported on this transport */
    }
  },

  newTerminal: async (workspaceId, shell) => {
    const wid = workspaceId ?? get().activeWorkspaceId ?? undefined;
    const t = await window.kotrain.createTerminal({ workspaceId: wid, shell });
    await get().refreshTerminals();
    set({ view: 'chat' });
    get().openTerminalPane(t.id);
  },

  openChatPane: (sessionId) => {
    set((s) => {
      const hit = locatePane(s.groups, 'chat', sessionId);
      if (hit) {
        return {
          activeSessionId: sessionId,
          activeGroupId: hit.groupId,
          groups: s.groups.map((g) => (g.id === hit.groupId ? { ...g, activeId: hit.paneId } : g)),
        };
      }
      const next = addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'chat', refId: sessionId });
      return { ...next, activeSessionId: sessionId };
    });
  },

  openTerminalPane: (terminalId) => {
    set((s) => {
      const hit = locatePane(s.groups, 'terminal', terminalId);
      if (hit) {
        return {
          activeGroupId: hit.groupId,
          groups: s.groups.map((g) => (g.id === hit.groupId ? { ...g, activeId: hit.paneId } : g)),
        };
      }
      return addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'terminal', refId: terminalId });
    });
  },

  openFilePane: (path) => {
    set((s) => {
      const hit = locatePane(s.groups, 'file', path);
      if (hit) {
        return {
          activeGroupId: hit.groupId,
          groups: s.groups.map((g) => (g.id === hit.groupId ? { ...g, activeId: hit.paneId } : g)),
        };
      }
      return { ...addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'file', refId: path }), view: 'chat' as View };
    });
  },

  openBrowserPane: (url) => {
    set((s) => {
      const ref = url || 'about:blank';
      const hit = locatePane(s.groups, 'browser', ref);
      if (hit) {
        return {
          activeGroupId: hit.groupId,
          groups: s.groups.map((g) => (g.id === hit.groupId ? { ...g, activeId: hit.paneId } : g)),
        };
      }
      return { ...addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'browser', refId: ref }), view: 'chat' as View };
    });
  },

  openHypergatePane: () => {
    set((s) => {
      // One manager, so one tab: any existing Hypergate pane is *the* pane,
      // whatever URL it was opened with (the port can change between runs).
      const hit = s.groups.flatMap((g) => g.panes.map((p) => ({ g, p }))).find((x) => x.p.kind === 'hypergate');
      const url = s.hypergate?.uiUrl ?? `http://localhost:${s.hypergate?.port ?? 7777}/`;
      if (hit) {
        return {
          activeGroupId: hit.g.id,
          view: 'chat' as View,
          groups: s.groups.map((g) =>
            g.id === hit.g.id
              ? { ...g, activeId: hit.p.id, panes: g.panes.map((p) => (p.id === hit.p.id ? { ...p, refId: url } : p)) }
              : g,
          ),
        };
      }
      return { ...addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'hypergate', refId: url }), view: 'chat' as View };
    });
  },

  hypergate: undefined,
  refreshHypergate: async (port) => {
    try {
      const found = await window.kotrain.detectHypergate(port);
      // Probing is anonymous by design, so a re-probe of the same daemon must
      // not forget what connecting to it taught us (which agent we are).
      set((s) => ({
        hypergate: found && s.hypergate?.port === found.port ? { ...s.hypergate, ...found } : found,
      }));
    } catch {
      // An older host (or the web edition talking to one) has no such channel;
      // "no daemon" is the honest answer there, not an error worth showing.
      set({ hypergate: null });
    }
  },
  connectHypergate: async (port) => {
    try {
      const info = await window.kotrain.connectHypergate(port);
      if (!info) {
        get().pushToast('error', `Hypergate isn't running on port ${port ?? 7777}. Start it, then connect again.`);
        set({ hypergate: null });
        return false;
      }
      set({ hypergate: info });
      // The entry now lives in settings; re-read so the MCP list on screen
      // shows it without a manual refresh.
      await get().refreshSettings();
      get().openHypergatePane();
      get().pushToast(
        'success',
        `Hypergate connected: ${info.servers} server${info.servers === 1 ? '' : 's'}, tools now in every chat.`,
      );
      return true;
    } catch (e) {
      get().pushToast('error', `Could not connect Hypergate: ${(e as Error).message}`);
      return false;
    }
  },

  sendToChat: async (text, run) => {
    // Target the active chat; create one if there isn't a usable session.
    let sid = get().activeSessionId;
    if (!sid || !get().sessions.some((s) => s.id === sid)) {
      const s = await window.kotrain.createSession(get().activeWorkspaceId ?? undefined);
      await get().refreshSessions();
      sid = s.id;
      set({ activeSessionId: sid });
    }
    set({ view: 'chat' });
    get().openChatPane(sid);
    set({ composerInbox: { sessionId: sid, text, run } });
  },

  refreshSessionPrs: async (sessionId) => {
    try {
      const prs = await window.kotrain.listSessionPrs(sessionId);
      set((s) => ({ prsBySession: { ...s.prsBySession, [sessionId]: prs } }));
    } catch {
      /* older host without PR channels, or gh/API unavailable */
    }
  },

  openPrPane: (url) => {
    set((s) => {
      const hit = locatePane(s.groups, 'pr', url);
      if (hit) {
        return {
          activeGroupId: hit.groupId,
          groups: s.groups.map((g) => (g.id === hit.groupId ? { ...g, activeId: hit.paneId } : g)),
        };
      }
      return { ...addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'pr', refId: url }), view: 'chat' as View };
    });
  },

  openDiffPane: (sessionId) => {
    set((s) => {
      const hit = locatePane(s.groups, 'diff', sessionId);
      if (hit) {
        return {
          activeGroupId: hit.groupId,
          groups: s.groups.map((g) => (g.id === hit.groupId ? { ...g, activeId: hit.paneId } : g)),
        };
      }
      return { ...addPane(s.groups, s.activeGroupId, { id: newPaneId(), kind: 'diff', refId: sessionId }), view: 'chat' as View };
    });
  },

  closePane: (groupId, paneId) => {
    set((s) => {
      let groups = s.groups
        .map((g) => {
          if (g.id !== groupId) return g;
          const panes = g.panes.filter((p) => p.id !== paneId);
          const activeId = g.activeId === paneId ? panes[panes.length - 1]?.id ?? null : g.activeId;
          return { ...g, panes, activeId };
        })
        .filter((g) => g.panes.length > 0);
      const activeGroupId = groups.some((g) => g.id === s.activeGroupId) ? s.activeGroupId : groups[0]?.id ?? null;
      return { groups, activeGroupId };
    });
  },

  setActivePane: (groupId, paneId) => {
    set((s) => {
      const pane = s.groups.find((g) => g.id === groupId)?.panes.find((p) => p.id === paneId);
      return {
        activeGroupId: groupId,
        activeSessionId: pane?.kind === 'chat' ? pane.refId : s.activeSessionId,
        groups: s.groups.map((g) => (g.id === groupId ? { ...g, activeId: paneId } : g)),
      };
    });
  },

  focusGroup: (groupId) => set({ activeGroupId: groupId }),

  splitRight: (groupId, paneId) => {
    set((s) => {
      if (s.groups.length >= MAX_GROUPS) return s;
      const src = s.groups.find((g) => g.id === groupId);
      const pane = src?.panes.find((p) => p.id === paneId);
      if (!src || !pane || src.panes.length <= 1) return s; // nothing to split off
      const remaining = src.panes.filter((p) => p.id !== paneId);
      const moved: WbGroup = { id: newGroupId(), panes: [pane], activeId: pane.id };
      const groups: WbGroup[] = [];
      for (const g of s.groups) {
        if (g.id === groupId) {
          groups.push({ ...g, panes: remaining, activeId: g.activeId === paneId ? remaining[remaining.length - 1]?.id ?? null : g.activeId });
          groups.push(moved);
        } else groups.push(g);
      }
      return { groups, activeGroupId: moved.id };
    });
  },

  reorderWorkspaces: async (orderedIds) => {
    const s = get().settings;
    if (!s) return;
    const byId = new Map(s.workspaces.map((w) => [w.id, w]));
    const workspaces = orderedIds.map((id) => byId.get(id)).filter((w): w is NonNullable<typeof w> => !!w);
    if (workspaces.length !== s.workspaces.length) return; // guard against a lost entry
    await window.kotrain.updateSettings({ workspaces });
    await get().refreshSettings();
  },

  layoutChats: async (targetWorkspaceId, orderedIds, moveId) => {
    if (moveId) await window.kotrain.setSessionWorkspace(moveId, targetWorkspaceId);
    await Promise.all(orderedIds.map((id, i) => window.kotrain.setSessionOptions(id, { order: i })));
    await get().refreshSessions();
  },

  layoutTerminals: async (targetWorkspaceId, orderedIds, moveId) => {
    if (moveId) await window.kotrain.updateTerminal(moveId, { workspaceId: targetWorkspaceId ?? null });
    await Promise.all(orderedIds.map((id, i) => window.kotrain.updateTerminal(id, { order: i })));
    await get().refreshTerminals();
  },
}));
