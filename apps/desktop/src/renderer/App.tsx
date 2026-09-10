import React, { useEffect } from 'react';
import { useStore, viewEnabled, type View } from './store.js';
import { useT } from './i18n.js';
import { SHORTCUTS } from './shortcuts.js';
import { hasAppChrome } from './chrome.js';
import { TitleBar } from './components/TitleBar.js';
import { Mascot, NekkoAvatar } from './components/Mascot.js';
import { ResourceHud } from './components/ResourceMonitor.js';
import { Toasts } from './components/Toasts.js';
import { CommandPalette } from './components/CommandPalette.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { RelayPairing } from './components/RelayPairing.js';
import { DeepLinkListener } from './components/DeepLink.js';
import { WorkbenchView } from './views/WorkbenchView.js';
import { DesignBoardView } from './views/DesignBoardView.js';
import { SkillsView } from './views/SkillsView.js';
import { TrainingView } from './views/TrainingView.js';
import { WorkflowsView } from './views/WorkflowsView.js';
import { CommandCenterView } from './views/CommandCenterView.js';
import { ModelsView } from './views/ModelsView.js';
import { ConnectorsView } from './views/ConnectorsView.js';
import { MemoryView } from './views/MemoryView.js';
import { SettingsView } from './views/SettingsView.js';
import { OnboardingView } from './views/OnboardingView.js';
import {
  CommandHudIcon,
  SkillsColorIcon,
  TrainingColorIcon,
  WorkflowsColorIcon,
  DesignColorIcon,
  ModelsColorIcon,
  ConnectorsColorIcon,
  MemoryColorIcon,
  SettingsColorIcon,
} from './navIcons.js';

/** The Agent destination wears Aphelion herself, so the cat is the way in. */
const AgentCatIcon = (_p: { className?: string }) => <NekkoAvatar size={22} />;

const NAV: Array<{ view: View; labelKey: string; Icon: (p: { className?: string }) => React.JSX.Element }> = [
  { view: 'command', labelKey: 'nav.command', Icon: CommandHudIcon },
  { view: 'chat', labelKey: 'nav.chat', Icon: AgentCatIcon },
  { view: 'skills', labelKey: 'nav.skills', Icon: SkillsColorIcon },
  { view: 'training', labelKey: 'nav.training', Icon: TrainingColorIcon },
  { view: 'workflows', labelKey: 'nav.workflows', Icon: WorkflowsColorIcon },
  { view: 'design', labelKey: 'nav.design', Icon: DesignColorIcon },
  { view: 'models', labelKey: 'nav.models', Icon: ModelsColorIcon },
  { view: 'connectors', labelKey: 'nav.connectors', Icon: ConnectorsColorIcon },
  { view: 'memory', labelKey: 'nav.memory', Icon: MemoryColorIcon },
  { view: 'settings', labelKey: 'nav.settings', Icon: SettingsColorIcon },
];

/** Phone bottom-tab destinations (the remote-control essentials). */
const MOBILE_NAV: View[] = ['command', 'chat', 'training', 'workflows', 'settings'];

export function App() {
  const { view, setView, mascotMood, settings, settingsLoaded, providers, onboardingOpen, refreshSettings, refreshProviders, refreshSessions, refreshTerminals } = useStore();
  const t = useT();

  // Experimental surfaces only exist in the nav once their Settings flag is on.
  const visibleNav = NAV.filter((n) => viewEnabled(n.view, settings));
  const mobileNav = MOBILE_NAV.filter((v) => viewEnabled(v, settings));

  // If the surface you're looking at gets switched off (say from another
  // client over the same settings file), land somewhere real.
  useEffect(() => {
    if (!viewEnabled(view, settings)) setView('command');
  }, [view, settings, setView]);

  useEffect(() => {
    refreshSettings();
    refreshProviders();
    refreshSessions();
    refreshTerminals();
    useStore.getState().refreshSkills();
    // Probe for Hypergate once at startup so the pairing is offered wherever
    // the user happens to be, not only after they open Settings.
    useStore.getState().refreshHypergate();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => useStore.getState().applyTheme();
    mq.addEventListener('change', onChange);

    // Global keyboard shortcuts (chords + their hint labels live in shortcuts.ts).
    const onKey = (e: KeyboardEvent) => {
      // While the setup wizard owns the screen its own keys apply (arrows,
      // Esc); firing global shortcuts underneath it would be a surprise.
      if (useStore.getState().onboardingOpen) return;
      if (SHORTCUTS.palette.matches(e)) {
        e.preventDefault();
        useStore.getState().setPaletteOpen(!useStore.getState().paletteOpen);
      } else if (SHORTCUTS.newAgent.matches(e)) {
        e.preventDefault();
        useStore.getState().newChat();
      } else if (SHORTCUTS.newTerminal.matches(e)) {
        e.preventDefault();
        useStore.getState().newTerminal();
      } else if (SHORTCUTS.contextPanel.matches(e)) {
        e.preventDefault();
        useStore.getState().toggleContextPanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      mq.removeEventListener('change', onChange);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native (mobile) only: notify when an agent run finishes while the app is
  // backgrounded. Local notification, no push backend / APNs / FCM needed.
  useEffect(() => {
    const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    let off: (() => void) | undefined;
    let nid = 1;
    (async () => {
      try {
        const { LocalNotifications } = await import('@capacitor/local-notifications');
        await LocalNotifications.requestPermissions();
        off = window.nekko.onAgentEvent((e) => {
          if (e.type === 'done' && document.hidden) {
            LocalNotifications.schedule({
              notifications: [{ id: nid++, title: 'Agent Nekko finished', body: 'Your task is ready in Agent Nekko.' }],
            }).catch(() => {});
          }
        });
      } catch {
        /* plugin unavailable */
      }
    })();
    return () => off?.();
  }, []);

  // Native (mobile) only: register for remote push and hand the token to the
  // relay, so a finished run can notify the phone even when it's offline.
  useEffect(() => {
    const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    let cancelled = false;
    (async () => {
      try {
        const { PushNotifications } = await import('@capacitor/push-notifications');
        const platform = cap.getPlatform?.() === 'android' ? 'android' : 'ios';
        const perm = await PushNotifications.requestPermissions();
        if (perm.receive !== 'granted') return;
        await PushNotifications.addListener('registration', (t) => {
          if (!cancelled) window.nekko.registerPushToken(t.value, platform).catch(() => {});
        });
        await PushNotifications.register();
      } catch {
        /* push not configured in this build */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="flex h-full w-full flex-col" style={{ background: 'var(--paper)' }}>
      {/* The window's own title bar, in the desktop shell only. */}
      <TitleBar />

      {!settingsLoaded ? (
        <div className="relative flex min-h-0 w-full flex-1 items-center justify-center">
          <span className="text-ink-faint">Loading…</span>
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 w-full flex-1">
            {/* Left rail: icon-only at rest, expands over the content on hover to
            reveal each destination's label. Hidden on phones (hover is useless on
            touch), where the bottom tab bar below takes over. */}
        <nav className="relative z-40 hidden w-16 shrink-0 md:block">
          <div className="rail absolute inset-y-0 left-0 flex flex-col gap-1 overflow-hidden bg-paper px-2.5 py-4">
            {/* Wordmark only, no logo mark: the cat now lives on the Agent tab.
                In the desktop shell the title bar carries it instead, so it isn't
                shown twice and the rail starts on its first destination. */}
            {!hasAppChrome && (
              <div className="mb-3 flex h-9 items-center px-1.5">
                <span className="rail-label text-[15px] font-semibold tracking-tight">Agent Nekko</span>
              </div>
            )}
            {visibleNav.map(({ view: v, labelKey, Icon }) => (
              <button
                key={v}
                className={`nav-item ${view === v ? 'active' : ''}`}
                aria-label={t(labelKey)}
                onClick={() => setView(v)}
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center"><Icon /></span>
                <span className="rail-label text-[13px] font-medium">{t(labelKey)}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Main (bottom padding on phones so the tab bar never covers content) */}
        <main className="relative flex min-w-0 flex-1 flex-col pb-16 md:pb-0">
          {providers.length === 0 && view !== 'models' && view !== 'settings' && (
            <button
              className="flex items-center justify-center gap-2 border-b border-line py-2.5 text-[13px]"
              style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              onClick={() => setView('models')}
            >
              <span className="font-medium">Get started:</span> connect your first model in Models →
            </button>
          )}
          {view === 'command' && <CommandCenterView />}
          {view === 'chat' && <WorkbenchView />}
          {view === 'skills' && <SkillsView />}
          {view === 'training' && <TrainingView />}
          {view === 'workflows' && <WorkflowsView />}
          {view === 'design' && <DesignBoardView />}
          {view === 'models' && <ModelsView />}
          {view === 'connectors' && <ConnectorsView />}
          {view === 'memory' && <MemoryView />}
          {view === 'settings' && <SettingsView />}
        </main>

        {/* First-run setup wizard: covers nav + main but leaves the window's
            title bar (and its OS buttons) reachable above it. */}
        {onboardingOpen && <OnboardingView />}
      </div>

      {/* Phone bottom tab bar: the remote-control surface. The long tail of
          destinations (models, connectors, …) stays reachable via ⌘K / More. */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-line md:hidden"
        style={{ background: 'var(--paper)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {mobileNav.map((v) => {
          const item = NAV.find((n) => n.view === v)!;
          const { Icon } = item;
          return (
            <button
              key={v}
              className="flex flex-1 flex-col items-center gap-0.5 py-1.5"
              style={view === v ? { color: 'var(--accent)' } : { color: 'var(--ink-faint)' }}
              aria-label={t(item.labelKey)}
              onClick={() => setView(v)}
            >
              <span className="grid h-7 w-7 place-items-center"><Icon /></span>
              <span className="text-[10px] font-medium">{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      </>)}

      {/* Global overlays stay mounted even while settings load, so deep links,
          toasts, and update banners keep working on any settings failure. */}
      <UpdateBanner />
      <RelayPairing />
      <ResourceHud />
      <Mascot mood={mascotMood} enabled={settings?.mascotEnabled ?? true} />
      <CommandPalette />
      <DeepLinkListener />
      <Toasts />
    </div>
  );
}
