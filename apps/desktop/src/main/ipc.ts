import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IpcChannels, IpcEvents, withApiServerDefaults, type AgentToolId, type ApiServerSettings, type SubagentTarget } from '@agent-nekko/shared';
import { createDispatcher, type Host } from '@agent-nekko/host';
import { initUpdater, checkForUpdates, downloadUpdate, quitAndInstall } from './update.js';
import { apiServerStatus, newApiToken, syncApiServer } from './api-server.js';
import { cliInstallStatus, installCli } from './cli-install.js';
import { refreshLocalAccess, subagentTarget } from './local-access.js';

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

  // The local API server. Transport-local by nature: the web and self-hosted
  // editions already are this server, so there is nothing for them to switch on.
  ipcMain.removeHandler(IpcChannels.apiServerStatus);
  ipcMain.handle(IpcChannels.apiServerStatus, () => apiServerStatus(host));
  ipcMain.removeHandler(IpcChannels.apiServerSave);
  ipcMain.handle(IpcChannels.apiServerSave, (_e, patch: Partial<ApiServerSettings>) => {
    const current = withApiServerDefaults(host.getSettings().apiServer);
    const next = { ...current, ...patch };
    // Switching it on without a token would be switching on an unauthenticated
    // agent endpoint, so the first "on" mints one rather than refusing.
    if (next.enabled && !next.token) next.token = newApiToken();
    host.updateSettings({ apiServer: next });
    syncApiServer(host);
    // A new port, address or token has to reach the CLI's link file and the
    // MCP entries this app wrote, or they keep dialling the old one.
    refreshLocalAccess(app, host);
    return apiServerStatus(host);
  });
  ipcMain.removeHandler(IpcChannels.apiServerNewToken);
  ipcMain.handle(IpcChannels.apiServerNewToken, () => {
    const current = withApiServerDefaults(host.getSettings().apiServer);
    host.updateSettings({ apiServer: { ...current, token: newApiToken() } });
    syncApiServer(host);
    refreshLocalAccess(app, host);
    return apiServerStatus(host);
  });

  // The bundled CLI's launcher and PATH entry. Desktop only: the web and
  // self-hosted editions have no binary to link, and report so themselves.
  ipcMain.removeHandler(IpcChannels.cliInstallStatus);
  ipcMain.handle(IpcChannels.cliInstallStatus, () => cliInstallStatus(app));
  ipcMain.removeHandler(IpcChannels.cliInstall);
  ipcMain.handle(IpcChannels.cliInstall, () => {
    const status = installCli(app);
    // Entries written before the launcher existed used npx; now they can
    // name the launcher instead.
    refreshLocalAccess(app, host);
    return status;
  });

  // MCP entries written from this window point at this window's server: the
  // renderer asks for "install into Claude Code" and the transport fills in
  // the address, token and launcher, which the renderer never has to hold.
  ipcMain.removeHandler(IpcChannels.integrationsInstall);
  ipcMain.handle(IpcChannels.integrationsInstall, (_e, tool: AgentToolId, target?: SubagentTarget) =>
    host.installSubagent(tool, target ?? subagentTarget(app, host)),
  );
  ipcMain.removeHandler(IpcChannels.integrationsSnippet);
  ipcMain.handle(IpcChannels.integrationsSnippet, (_e, tool: AgentToolId, target?: SubagentTarget) =>
    host.subagentSnippet(tool, target ?? subagentTarget(app, host)),
  );

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
