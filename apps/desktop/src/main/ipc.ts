import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IpcChannels, IpcEvents } from '@agent-nekko/shared';
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from './update.js';
import type { EngineProcess } from './engine-process.js';
import { ENGINE_ENDPOINT_CHANNEL, PICK_FOLDER_CHANNEL } from '../engineChannels.js';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * What only the Electron main process can answer. Every other channel goes
 * from the preload straight to the engine over its socket (see
 * `preload/index.ts`), so this list is short on purpose: native dialogs, the
 * OS shell, the app's own version, the updater, and where the engine is.
 */
export function registerIpc(engine: EngineProcess): void {
  ipcMain.handle(ENGINE_ENDPOINT_CHANNEL, () => engine.endpoint());

  // Native folder picker. The preload adds the chosen path through the engine.
  ipcMain.handle(PICK_FOLDER_CHANNEL, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
  });

  // Native multi-file picker → absolute paths.
  ipcMain.handle(IpcChannels.dialogOpenFiles, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });

  // Reveal/open a path or URL with the OS.
  ipcMain.handle(IpcChannels.openPath, async (_e, target: string) => {
    if (/^https?:\/\//i.test(target)) await shell.openExternal(target);
    else await shell.openPath(target);
  });

  // App info (real Electron version + desktop edition).
  ipcMain.handle(IpcChannels.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    edition: 'desktop' as const,
  }));

  // Auto-update controls (electron-updater).
  initUpdater((u) => broadcast(IpcEvents.updateEvent, u));
  ipcMain.handle(IpcChannels.updateCheck, () => checkForUpdates());
  ipcMain.handle(IpcChannels.updateDownload, () => downloadUpdate());
  ipcMain.handle(IpcChannels.updateInstall, () => quitAndInstall());
}
