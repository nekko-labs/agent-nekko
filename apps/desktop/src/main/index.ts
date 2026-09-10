import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { fileURLToPath } from 'url';
import { join, resolve, sep } from 'path';
import { existsSync, cpSync } from 'fs';
import { createHost } from '@agent-nekko/host';
import { IpcEvents } from '@agent-nekko/shared';
import { registerIpc } from './ipc.js';
import { checkForUpdates } from './update.js';
import { loadWindowBounds, saveWindowBounds } from './windowState.js';
import { preservePackagedProfile } from './appIdentity.js';
import { closeWorkflowLoopbackListener, manageWorkflowLoopbackListener } from './workflow-listener.js';
import {
  TITLEBAR_HEIGHT,
  TITLEBAR_OVERLAY_CHANNEL,
  type TitleBarOverlayTheme,
} from '../windowChrome.js';

preservePackagedProfile(app);

/**
 * What the native buttons look like before the renderer has told us the theme.
 *
 * Dark `--paper` and `--ink-soft`, because the window is created with a dark
 * background and a light-themed overlay would flash white in the corner for
 * the frame or two before the page mounts.
 */
const DEFAULT_OVERLAY: TitleBarOverlayTheme = { color: '#0c0c11', symbolColor: '#a3a1b0' };

/**
 * The URL schemes other apps use to reach Agent Nekko
 * (`agent-nekko://hypergate/connect`). The current name is first and is what
 * gets advertised; the older brands stay registered because a Hypergate built
 * against one of them still emits it, and that install upgrades on its own
 * schedule.
 */
const PROTOCOLS = ['agent-nekko', 'kotrain', 'nekkos'] as const;

/**
 * An `agent-nekko://` URL waiting for a window to hand it to.
 *
 * A cold launch *from* a link arrives before the renderer exists, so the link
 * is parked here and replayed once the page says it is listening. Only the
 * newest is kept: these are commands, and a queue of stale ones fired at once
 * is not what anybody clicked.
 */
let pendingLink: string | null = null;

/** Pick an `agent-nekko://` URL out of a command line (Windows and Linux pass it as an argument). */
function linkFromArgv(argv: string[]): string | null {
  return argv.find((a) => PROTOCOLS.some((scheme) => a.startsWith(`${scheme}://`))) ?? null;
}

/**
 * Send a deep link to the window, or hold it until one is ready.
 *
 * Also raises the window: the point of the link is that the user clicked
 * something in *another* app and expects Kotrain to come forward and show them
 * the result.
 */
function deliverLink(url: string): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.webContents.isLoading()) {
    pendingLink = url;
    if (!win) createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send(IpcEvents.deepLink, url);
}

function resolveWindowIcon(): string | undefined {
  const candidates = [
    join(__dirname, '../renderer/icon-512.png'),
    join(__dirname, '../renderer/public/icon-512.png'),
    join(__dirname, '../../src/renderer/public/icon-512.png'),
  ];
  return candidates.find((path) => existsSync(path));
}

function createWindow(): void {
  const bounds = loadWindowBounds();
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: DEFAULT_OVERLAY.color,
    icon: resolveWindowIcon(),
    // One bar, not three. The app draws its own title strip (see
    // `windowChrome.ts`), so the OS contributes buttons and nothing else: no
    // title bar and no File/Edit/View/Window strip stacked above the UI.
    titleBarStyle: 'hidden',
    // macOS keeps its traffic lights; centre them in our strip so they sit on
    // the wordmark's line. Windows and Linux get the Window Controls Overlay,
    // painted in the app's own background so the buttons read as part of the
    // page rather than as a frame around it.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: (TITLEBAR_HEIGHT - 16) / 2 } }
      : { titleBarOverlay: { ...DEFAULT_OVERLAY, height: TITLEBAR_HEIGHT } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Enable <webview> for the in-app browser pane (BrowserPane).
      webviewTag: true,
    },
  });

  win.on('ready-to-show', () => win.show());

  // A link that arrived before the page could listen (a cold launch from
  // Hypergate's Connect button) is replayed the moment it can.
  win.webContents.on('did-finish-load', () => {
    if (!pendingLink) return;
    const url = pendingLink;
    pendingLink = null;
    win.webContents.send(IpcEvents.deepLink, url);
  });

  // Reload and devtools used to hang off the View menu. The menu is gone, the
  // shortcuts people reach for shouldn't be, so bind the two that were worth
  // keeping directly. Everything else in that menu duplicated a shortcut the
  // app already owns (see `shortcuts.ts`) or a gesture Chromium handles itself.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (key === 'f12' || (mod && input.shift && key === 'i')) {
      event.preventDefault();
      win.webContents.toggleDevTools();
    } else if (mod && key === 'r') {
      event.preventDefault();
      win.webContents.reload();
    }
  });

  // Persist size/position (debounced) so the window reopens where it was.
  let saveTimer: NodeJS.Timeout | undefined;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (win.isDestroyed() || win.isMinimized()) return;
      const b = win.getBounds();
      saveWindowBounds(b);
    }, 400);
  };
  win.on('resize', persist);
  win.on('move', persist);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
    const sameApp = rendererUrl
      ? (() => {
          try {
            return new URL(url).origin === new URL(rendererUrl).origin;
          } catch {
            return false;
          }
        })()
      : (() => {
          if (!url.startsWith('file://')) return false;
          try {
            const target = resolve(fileURLToPath(url));
            const rendererDir = resolve(join(__dirname, '../renderer'));
            return target === rendererDir || target.startsWith(`${rendererDir}${sep}`);
          } catch {
            return false;
          }
        })();
    if (sameApp) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (!/^https?:\/\//i.test(params.src) && params.src !== 'about:blank') {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Installs from an earlier brand kept their data under the "Kotrain",
 * "Nekkos" or "Open Paw" userData dir (whatever productName was then). Copy it
 * into the Agent Nekko location once, on first run after the rename, so nobody
 * loses chats/settings. Newest brand first: an install that already went
 * through one rename has the most recent data under the latest of these.
 */
function migrateLegacyData(nextDir: string): void {
  try {
    if (existsSync(nextDir)) return;
    const legacies = [
      join(app.getPath('userData'), 'kotrain'),
      join(app.getPath('userData'), '..', 'Kotrain', 'kotrain'),
      join(app.getPath('userData'), '..', 'Nekkos', 'nekkos'),
      join(app.getPath('userData'), '..', 'Open Paw', 'open-paw'),
    ];
    for (const legacy of legacies) {
      if (existsSync(legacy)) {
        cpSync(legacy, nextDir, { recursive: true });
        return;
      }
    }
  } catch (err) {
    console.error('[agent-nekko] legacy data migration failed:', err);
  }
}

/**
 * Keep the native buttons the same colour as the strip they sit in.
 *
 * The renderer owns the theme (system, light, dark, plus a user accent), so it
 * is the only side that knows what `--paper` currently resolves to; without
 * this the buttons stay dark after the app goes light.
 */
function registerTitleBarOverlaySync(): void {
  ipcMain.on(TITLEBAR_OVERLAY_CHANNEL, (e, theme: TitleBarOverlayTheme) => {
    if (process.platform === 'darwin') return;
    const win = BrowserWindow.fromWebContents(e.sender);
    try {
      win?.setTitleBarOverlay({ ...theme, height: TITLEBAR_HEIGHT });
    } catch {
      /* the platform has no overlay to repaint */
    }
  });
}

/**
 * Register `kotrain://` with the OS and make sure a link reaches the app that
 * is already open.
 *
 * The single-instance lock is what makes that true: without it the OS answers
 * a link by starting a *second* Kotrain on the same data directory, two hosts
 * writing one settings file. With it, the second process hands its argument to
 * the first and exits. Returns false when another instance already holds the
 * lock, meaning this process should quit immediately.
 */
function claimSingleInstance(): boolean {
  // In development the executable is Electron itself, so the registration has
  // to name the script too or the OS would launch a bare Electron shell.
  for (const scheme of PROTOCOLS) {
    if (process.defaultApp) {
      if (process.argv.length >= 2) app.setAsDefaultProtocolClient(scheme, process.execPath, [resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }

  if (!app.requestSingleInstanceLock()) return false;

  app.on('second-instance', (_e, argv) => {
    const link = linkFromArgv(argv);
    if (link) {
      deliverLink(link);
      return;
    }
    // Launched again without a link: the user asked for Kotrain, so show the
    // window they already have rather than doing nothing at all.
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    } else {
      createWindow();
    }
  });

  // macOS delivers links as an event, not as an argument, whether the app was
  // already running or was launched by the click.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverLink(url);
  });

  return true;
}

/** False in a second copy launched by a link; that one hands over and exits. */
const isPrimary = claimSingleInstance();
if (!isPrimary) app.quit();

app.whenReady().then(() => {
  if (!isPrimary) return;
  // No File/Edit/View/Window bar: it cost a whole strip of chrome above the UI
  // to duplicate shortcuts the app already owns. macOS keeps its menu — there
  // it lives in the system bar rather than in the window, and ⌘Q/⌘H/⌘W come
  // from it.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  const dataDir = join(app.getPath('userData'), 'agent-nekko');
  migrateLegacyData(dataDir);
  const host = createHost({ dataDir });
  registerIpc(host);
  manageWorkflowLoopbackListener(host);
  registerTitleBarOverlaySync();
  // A link that launched the app is already on this process's command line
  // (Windows/Linux); park it so the first load replays it.
  pendingLink = linkFromArgv(process.argv);
  createWindow();

  // Auto-check for updates a few seconds after launch, if the user opted in.
  if (host.getSettings().autoUpdate) {
    setTimeout(() => { void checkForUpdates(); }, 4000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  closeWorkflowLoopbackListener();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', closeWorkflowLoopbackListener);
