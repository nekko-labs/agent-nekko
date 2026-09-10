import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IpcChannels, IpcEvents } from '@agent-nekko/shared';
import { createDispatcher, type Host } from '@agent-nekko/host';
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from './update.js';

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
}

/**
 * Thin Electron transport over the shared Host. Every IPC channel is routed
 * through the shared dispatcher (one source of truth, reused by the web server),
 * except `workspaceAdd`, which needs Electron's native folder picker.
 */
export function registerIpc(host: Host): void {
  const dispatch = createDispatcher(host);

  for (const channel of Object.values(IpcChannels)) {
    ipcMain.handle(channel, (_e, ...args) => dispatch(channel, args));
  }

  // Native folder picker → host.addWorkspaceByPath (replaces the generic handler).
  ipcMain.removeHandler(IpcChannels.workspaceAdd);
  ipcMain.handle(IpcChannels.workspaceAdd, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return host.listWorkspaces();
    return host.addWorkspaceByPath(res.filePaths[0]);
  });

  // Native multi-file picker → absolute paths (transport-local, not in dispatcher).
  ipcMain.removeHandler(IpcChannels.dialogOpenFiles);
  ipcMain.handle(IpcChannels.dialogOpenFiles, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
    });
    return res.canceled ? [] : res.filePaths;
  });

  // Reveal/open a path or URL with the OS (transport-local, not in dispatcher).
  ipcMain.removeHandler(IpcChannels.openPath);
  ipcMain.handle(IpcChannels.openPath, async (_e, target: string) => {
    if (/^https?:\/\//i.test(target)) await shell.openExternal(target);
    else await shell.openPath(target);
  });

  // App info (real Electron version + desktop edition), overrides the host's.
  ipcMain.removeHandler(IpcChannels.appInfo);
  ipcMain.handle(IpcChannels.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    edition: 'desktop' as const,
  }));

  // Auto-update controls (electron-updater; transport-local).
  initUpdater((u) => broadcast(IpcEvents.updateEvent, u));
  ipcMain.removeHandler(IpcChannels.updateCheck);
  ipcMain.handle(IpcChannels.updateCheck, () => checkForUpdates());
  ipcMain.removeHandler(IpcChannels.updateDownload);
  ipcMain.handle(IpcChannels.updateDownload, () => downloadUpdate());
  ipcMain.removeHandler(IpcChannels.updateInstall);
  ipcMain.handle(IpcChannels.updateInstall, () => quitAndInstall());

  // Forward host events to all renderers.
  host.events.on('agentEvent', (e) => broadcast(IpcEvents.agentEvent, e));
  host.events.on('indexProgress', (s) => broadcast(IpcEvents.indexProgress, s));
  host.events.on('terminalEvent', (e) => broadcast(IpcEvents.terminalEvent, e));
  host.events.on('changesUpdated', (e) => broadcast(IpcEvents.changesUpdated, e));
  // The list-changed events, which were emitted by the host but never forwarded,
  // so onTasksUpdated / onTrainingUpdated never fired in the desktop app and
  // those surfaces only refreshed when remounted.
  host.events.on('tasksUpdated', (t) => broadcast(IpcEvents.tasksUpdated, t));
  host.events.on('trainingUpdated', (r) => broadcast(IpcEvents.trainingUpdated, r));
  host.events.on('workflowsUpdated', (s) => broadcast(IpcEvents.workflowsUpdated, s));
  host.events.on('oauthStatus', (s) => broadcast(IpcEvents.oauthStatus, s));
  host.events.on('limitsUpdated', (e) => broadcast(IpcEvents.limitsUpdated, e));
}
