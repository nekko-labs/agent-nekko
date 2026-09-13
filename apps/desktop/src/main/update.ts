import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { RELEASE_NOTES_URL, type UpdateInfo } from '@agent-nekko/shared';

// electron-updater ships CommonJS and `autoUpdater` is a lazy getter that
// constructs the updater on first access — that needs a real Electron app.
// Under ELECTRON_RUN_AS_NODE (some agent/CI shells set it) there is none, so
// both the getter and `app` itself are touched only behind the `app` guard.
const autoUpdater = () => electronUpdater.autoUpdater;

let emit: ((u: UpdateInfo) => void) | null = null;
let state: UpdateInfo = {
  state: 'idle',
  currentVersion: app?.getVersion?.() ?? 'dev',
  notesUrl: RELEASE_NOTES_URL,
  edition: 'desktop',
};

function set(patch: Partial<UpdateInfo>): void {
  state = { ...state, ...patch };
  emit?.(state);
}

/** Wire electron-updater events to a single emitter. Call once at startup. */
export function initUpdater(onEvent: (u: UpdateInfo) => void): void {
  emit = onEvent;
  if (!app) return;
  const updater = autoUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.on('checking-for-update', () => set({ state: 'checking', version: undefined, percent: undefined, message: undefined }));
  updater.on('update-available', (i) => set({ state: 'available', version: i.version, percent: undefined, message: undefined }));
  updater.on('update-not-available', () => set({ state: 'none', version: undefined, percent: undefined, message: undefined }));
  updater.on('error', (e) => set({ state: 'error', message: String((e as Error)?.message ?? e) }));
  updater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => set({ state: 'downloaded', version: i.version, percent: 100, message: undefined }));
}

export function currentUpdate(): UpdateInfo {
  return state;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  // electron-updater needs the packaged app-update.yml; in dev it just errors.
  if (!app || !app.isPackaged) {
    set({ state: 'none', message: 'Updates are available in the installed app.' });
    return state;
  }
  try {
    await autoUpdater().checkForUpdates();
  } catch (e) {
    set({ state: 'error', message: String((e as Error).message) });
  }
  return state;
}

export async function downloadUpdate(): Promise<UpdateInfo> {
  if (!app || state.state !== 'available') return state;
  try {
    set({ state: 'downloading', percent: 0 });
    await autoUpdater().downloadUpdate();
  } catch (e) {
    set({ state: 'error', message: String((e as Error).message) });
  }
  return state;
}

export function quitAndInstall(): void {
  if (!app) return;
  try {
    autoUpdater().quitAndInstall();
  } catch (error) {
    /* not packaged / nothing downloaded */
    throw error;
  }
}
