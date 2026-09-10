import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { RELEASE_NOTES_URL, type UpdateInfo } from '@agent-nekko/shared';

// electron-updater ships CommonJS; destructure the default import.
const { autoUpdater } = electronUpdater;

let emit: ((u: UpdateInfo) => void) | null = null;
let state: UpdateInfo = {
  state: 'idle',
  currentVersion: app.getVersion(),
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
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking', version: undefined, percent: undefined, message: undefined }));
  autoUpdater.on('update-available', (i) => set({ state: 'available', version: i.version, percent: undefined, message: undefined }));
  autoUpdater.on('update-not-available', () => set({ state: 'none', version: undefined, percent: undefined, message: undefined }));
  autoUpdater.on('error', (e) => set({ state: 'error', message: String((e as Error)?.message ?? e) }));
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => set({ state: 'downloaded', version: i.version, percent: 100, message: undefined }));
}

export function currentUpdate(): UpdateInfo {
  return state;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  // electron-updater needs the packaged app-update.yml; in dev it just errors.
  if (!app.isPackaged) {
    set({ state: 'none', message: 'Updates are available in the installed app.' });
    return state;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ state: 'error', message: String((e as Error).message) });
  }
  return state;
}

export async function downloadUpdate(): Promise<UpdateInfo> {
  if (state.state !== 'available') return state;
  try {
    set({ state: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (e) {
    set({ state: 'error', message: String((e as Error).message) });
  }
  return state;
}

export function quitAndInstall(): void {
  try {
    autoUpdater.quitAndInstall();
  } catch (error) {
    /* not packaged / nothing downloaded */
    throw error;
  }
}
