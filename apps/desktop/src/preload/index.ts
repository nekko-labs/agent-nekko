import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppSettings,
  ConnectorKind,
  GuardrailRule,
  MemoryEntry,
  MemoryScope,
  NekkoApi,
  ProviderConfig,
  SendOptions,
  AgentEvent,
  IndexStatus,
  UpdateInfo,
  TerminalEvent,
  OAuthStatus,
  SubscriptionLimits,
} from '@agent-nekko/shared';
import { IpcChannels, IpcEvents } from '@agent-nekko/shared';
import {
  TITLEBAR_HEIGHT,
  TITLEBAR_OVERLAY_CHANNEL,
  type TitleBarOverlayTheme,
  type WindowChromeBridge,
} from '../windowChrome.js';

const inv = ipcRenderer.invoke.bind(ipcRenderer);

const api: NekkoApi = {
  getSettings: () => inv(IpcChannels.settingsGet),
  updateSettings: (patch) => inv(IpcChannels.settingsUpdate, patch),

  listProviders: () => inv(IpcChannels.providersList),
  saveProvider: (p: ProviderConfig) => inv(IpcChannels.providersSave, p),
  removeProvider: (id) => inv(IpcChannels.providersRemove, id),
  discoverProviders: () => inv(IpcChannels.providersDiscover),
  probeProviders: () => inv(IpcChannels.providersProbe),
  testProvider: (id) => inv(IpcChannels.providersTest, id),
  testProviderConfig: (cfg) => inv(IpcChannels.providersTestConfig, cfg),

  listModels: (providerId) => inv(IpcChannels.modelsList, providerId),
  pullModel: (providerId, model) => inv(IpcChannels.modelPull, providerId, model),
  loadModel: (providerId, model) => inv(IpcChannels.modelLoad, providerId, model),
  unloadModel: (providerId, model) => inv(IpcChannels.modelUnload, providerId, model),
  lmsAvailable: (providerId) => inv(IpcChannels.lmsProbe, providerId),
  stopServer: (providerId) => inv(IpcChannels.serverStop, providerId),
  runtimeStatus: (providerId) => inv(IpcChannels.runtimeStatus, providerId),
  runtimeStart: (providerId) => inv(IpcChannels.runtimeStart, providerId),
  runtimeStop: (providerId, force) => inv(IpcChannels.runtimeStop, providerId, force),
  runtimeLoad: (providerId, modelId, params) => inv(IpcChannels.runtimeLoad, providerId, modelId, params),
  runtimeFacts: (providerId) => inv(IpcChannels.runtimeFacts, providerId),
  runtimePlan: (providerId, modelId, req) => inv(IpcChannels.runtimePlan, providerId, modelId, req),
  getGpuStats: () => inv(IpcChannels.gpuStats),
  getSystemStats: () => inv(IpcChannels.systemStats),

  listSessions: () => inv(IpcChannels.sessionsList),
  createSession: (workspaceId) => inv(IpcChannels.sessionCreate, workspaceId),
  getSession: (id) => inv(IpcChannels.sessionGet, id),
  deleteSession: (id) => inv(IpcChannels.sessionDelete, id),
  setSessionWorkspace: (sessionId, workspaceId) => inv(IpcChannels.sessionSetWorkspace, sessionId, workspaceId),
  setSessionSupportingWorkspaces: (sessionId, workspaceIds) => inv(IpcChannels.sessionSetSupportingWorkspaces, sessionId, workspaceIds),
  setSessionAttachments: (sessionId, paths) => inv(IpcChannels.sessionSetAttachments, sessionId, paths),
  sendChat: (opts: SendOptions) => inv(IpcChannels.chatSend, opts),
  abortChat: (sessionId) => inv(IpcChannels.chatAbort, sessionId),
  queuePrompt: (sessionId, text) => inv(IpcChannels.chatQueue, sessionId, text),
  dequeuePrompt: (sessionId, index) => inv(IpcChannels.chatDequeue, sessionId, index),
  approveTool: (sessionId, toolCallId, approved) => inv(IpcChannels.toolApprove, sessionId, toolCallId, approved),

  listTerminals: () => inv(IpcChannels.terminalsList),
  listShells: () => inv(IpcChannels.terminalShells),
  createTerminal: (opts) => inv(IpcChannels.terminalCreate, opts),
  terminalSnapshot: (id) => inv(IpcChannels.terminalSnapshot, id),
  updateTerminal: (id, patch) => inv(IpcChannels.terminalUpdate, id, patch),
  writeTerminal: (id, data) => inv(IpcChannels.terminalWrite, id, data),
  resizeTerminal: (id, cols, rows) => inv(IpcChannels.terminalResize, id, cols, rows),
  runInTerminal: (id, command) => inv(IpcChannels.terminalRun, id, command),
  signalTerminal: (id, signal) => inv(IpcChannels.terminalSignal, id, signal),
  closeTerminal: (id) => inv(IpcChannels.terminalClose, id),

  previewContext: (sessionId, attachedPaths) => inv(IpcChannels.contextPreview, sessionId, attachedPaths),
  toggleContextItem: (sessionId, itemId, included, pinned) =>
    inv(IpcChannels.contextToggle, sessionId, itemId, included, pinned),
  setContextPrefs: (sessionId, prefs) => inv(IpcChannels.contextSetPrefs, sessionId, prefs),

  buildSpec: (sessionId) => inv(IpcChannels.specBuild, sessionId),
  buildSpecDoc: (sessionId, docId, workspaceId) => inv(IpcChannels.specBuildDoc, sessionId, docId, workspaceId),
  readSpecDocs: (sessionId, workspaceId) => inv(IpcChannels.specReadDocs, sessionId, workspaceId),
  setSpecMethodology: (sessionId, methodologyId) => inv(IpcChannels.specSetMethodology, sessionId, methodologyId),
  toggleSpecTask: (sessionId, lineIndex, workspaceId) => inv(IpcChannels.specToggleTask, sessionId, lineIndex, workspaceId),
  setSpecLinked: (sessionId, linked) => inv(IpcChannels.specSetLinked, sessionId, linked),
  specPath: (sessionId) => inv(IpcChannels.specPath, sessionId),
  setSessionOptions: (id, patch) => inv(IpcChannels.sessionSetOptions, id, patch),
  truncateSession: (id, messageId) => inv(IpcChannels.sessionTruncate, id, messageId),
  clearSessions: (scope) => inv(IpcChannels.sessionsClear, scope),
  resetSettings: () => inv(IpcChannels.settingsReset),
  wipeAllData: () => inv(IpcChannels.dataWipe),
  listTools: () => inv(IpcChannels.toolsList),

  openFilesDialog: () => inv(IpcChannels.dialogOpenFiles),
  openPath: (path) => inv(IpcChannels.openPath, path),

  listMemory: (scope: MemoryScope, workspaceId) => inv(IpcChannels.memoryList, scope, workspaceId),
  saveMemory: (entry: MemoryEntry) => inv(IpcChannels.memorySave, entry),
  deleteMemory: (id) => inv(IpcChannels.memoryDelete, id),

  listWorkspaces: () => inv(IpcChannels.workspaceList),
  addWorkspace: () => inv(IpcChannels.workspaceAdd),
  addWorkspaceByPath: (path) => inv(IpcChannels.workspaceAddByPath, path),
  removeWorkspace: (id) => inv(IpcChannels.workspaceRemove, id),
  indexWorkspace: (id) => inv(IpcChannels.workspaceIndex, id),
  getIndexStatus: (id) => inv(IpcChannels.workspaceIndexStatus, id),
  searchWorkspace: (id, query) => inv(IpcChannels.workspaceSearch, id, query),
  listFiles: (id) => inv(IpcChannels.workspaceFiles, id),

  readFile: (path) => inv(IpcChannels.fileRead, path),
  writeFile: (path, content) => inv(IpcChannels.fileWrite, path, content),
  listDir: (path) => inv(IpcChannels.dirList, path),

  listChanges: (sessionId) => inv(IpcChannels.changesList, sessionId),
  acceptChange: (sessionId, path) => inv(IpcChannels.changeAccept, sessionId, path),
  acceptAllChanges: (sessionId) => inv(IpcChannels.changeAcceptAll, sessionId),

  listSessionPrs: (sessionId) => inv(IpcChannels.prSessionList, sessionId),
  getPrDiff: (url) => inv(IpcChannels.prDiff, url),
  prAction: (url, action) => inv(IpcChannels.prAction, url, action),

  listComments: (path) => inv(IpcChannels.commentsList, path),
  addComment: (path, line, lineText, comment) => inv(IpcChannels.commentAdd, path, line, lineText, comment),
  resolveComment: (path, id) => inv(IpcChannels.commentResolve, path, id),

  getDesignBoard: (workspaceId) => inv(IpcChannels.designGet, workspaceId),
  addDesignPage: (workspaceId, label, url) => inv(IpcChannels.designAddPage, workspaceId, label, url),
  updateDesignPage: (workspaceId, pageId, patch) => inv(IpcChannels.designUpdatePage, workspaceId, pageId, patch),
  removeDesignPage: (workspaceId, pageId) => inv(IpcChannels.designRemovePage, workspaceId, pageId),
  addDesignNote: (workspaceId, pageId, text) => inv(IpcChannels.designAddNote, workspaceId, pageId, text),
  resolveDesignNote: (workspaceId, pageId, noteId) => inv(IpcChannels.designResolveNote, workspaceId, pageId, noteId),
  generateDesign: (workspaceId, input) => inv(IpcChannels.designGenerate, workspaceId, input),

  listInstalledSkills: () => inv(IpcChannels.skillsInstalled),
  skillTargets: () => inv(IpcChannels.skillsTargets),
  installSkill: (skillId, target, payload) => inv(IpcChannels.skillInstall, skillId, target, payload),
  uninstallSkill: (skillId, target) => inv(IpcChannels.skillUninstall, skillId, target),
  vaizerCatalog: (refresh) => inv(IpcChannels.vaizerCatalog, refresh),
  vaizerSkillMd: (slug) => inv(IpcChannels.vaizerSkillMd, slug),

  listTasks: () => inv(IpcChannels.tasksList),
  createTask: (task) => inv(IpcChannels.taskCreate, task),
  updateTask: (id, patch) => inv(IpcChannels.taskUpdate, id, patch),
  deleteTask: (id) => inv(IpcChannels.taskDelete, id),
  runTaskNow: (id) => inv(IpcChannels.taskRunNow, id),

  listTrainingRuns: () => inv(IpcChannels.trainingList),
  createTrainingRun: (input) => inv(IpcChannels.trainingCreate, input),
  updateTrainingRun: (id, patch) => inv(IpcChannels.trainingUpdate, id, patch),
  deleteTrainingRun: (id) => inv(IpcChannels.trainingDelete, id),
  startTrainingRun: (id) => inv(IpcChannels.trainingStart, id),
  pauseTrainingRun: (id) => inv(IpcChannels.trainingPause, id),
  stopTrainingRun: (id) => inv(IpcChannels.trainingStop, id),
  addTrainingHint: (id, text) => inv(IpcChannels.trainingHint, id, text),

  listWorkflows: () => inv(IpcChannels.workflowsList),
  createWorkflow: (input) => inv(IpcChannels.workflowCreate, input),
  updateWorkflow: (id, patch) => inv(IpcChannels.workflowUpdate, id, patch),
  deleteWorkflow: (id) => inv(IpcChannels.workflowDelete, id),
  duplicateWorkflow: (id) => inv(IpcChannels.workflowDuplicate, id),
  runWorkflow: (id) => inv(IpcChannels.workflowRun, id),
  cancelWorkflowRun: (runId) => inv(IpcChannels.workflowCancel, runId),
  listWorkflowRuns: (workflowId) => inv(IpcChannels.workflowRuns, workflowId),
  dispatchWorkflowEvent: (event) => inv(IpcChannels.workflowEvent, event),

  listConnectors: () => inv(IpcChannels.connectorsList),
  connectConnector: (kind: ConnectorKind, token, settings) => inv(IpcChannels.connectorConnect, kind, token, settings),
  disconnectConnector: (kind: ConnectorKind) => inv(IpcChannels.connectorDisconnect, kind),
  fetchConnector: (kind: ConnectorKind, query) => inv(IpcChannels.connectorFetch, kind, query),

  detectAgentTools: () => inv(IpcChannels.integrationsDetect),
  installSubagent: (tool) => inv(IpcChannels.integrationsInstall, tool),
  subagentSnippet: (tool) => inv(IpcChannels.integrationsSnippet, tool),

  classifyCommand: (command) => inv(IpcChannels.guardrailsClassify, command),
  saveGuardrail: async (rule: GuardrailRule) => {
    const settings: AppSettings = await inv(IpcChannels.settingsGet);
    const guardrails = settings.guardrails.filter((g) => g.id !== rule.id);
    guardrails.push(rule);
    const updated: AppSettings = await inv(IpcChannels.settingsUpdate, { guardrails });
    return updated.guardrails;
  },

  getUsageSummary: () => inv(IpcChannels.usageSummary),
  getLimits: (tokenKey: string) => inv(IpcChannels.limitsGet, tokenKey),

  oauthBegin: (provider) => inv(IpcChannels.oauthBegin, provider),
  oauthFinish: (sessionId, pasted) => inv(IpcChannels.oauthFinish, sessionId, pasted),
  oauthCancel: (sessionId) => inv(IpcChannels.oauthCancel, sessionId),
  oauthStatus: (providerConfigId) => inv(IpcChannels.oauthStatus, providerConfigId),
  oauthSignOut: (providerConfigId) => inv(IpcChannels.oauthSignOut, providerConfigId),
  importCliAuth: () => inv(IpcChannels.providersImportCliAuth),

  enableRemote: (relayUrl) => inv(IpcChannels.remoteEnable, relayUrl),
  disableRemote: () => inv(IpcChannels.remoteDisable),
  getRemoteStatus: () => inv(IpcChannels.remoteStatus),
  getRemotePairing: () => inv(IpcChannels.remotePairing),
  startRemotePairing: () => inv(IpcChannels.remotePair),
  listRemoteDevices: () => inv(IpcChannels.remoteDevices),
  revokeRemoteDevice: (deviceId) => inv(IpcChannels.remoteRevoke, deviceId),
  renameRemoteDevice: (deviceId, name) => inv(IpcChannels.remoteRename, deviceId, name),
  rotateRemoteSecret: () => inv(IpcChannels.remoteRotate),

  getAppInfo: () => inv(IpcChannels.appInfo),
  getMcpStatus: () => inv(IpcChannels.mcpStatus),
  detectHypergate: (port?: number) => inv(IpcChannels.mcpHypergate, port),
  connectHypergate: (port?: number) => inv(IpcChannels.mcpHypergateConnect, port),
  registerPushToken: () => Promise.resolve(), // desktop isn't a relay client
  checkForUpdates: () => inv(IpcChannels.updateCheck),
  downloadUpdate: () => inv(IpcChannels.updateDownload),
  quitAndInstall: () => inv(IpcChannels.updateInstall),

  onAgentEvent: (cb: (e: AgentEvent) => void) => {
    const listener = (_: unknown, e: AgentEvent) => cb(e);
    ipcRenderer.on(IpcEvents.agentEvent, listener);
    return () => ipcRenderer.removeListener(IpcEvents.agentEvent, listener);
  },
  onOAuthStatus: (cb: (s: OAuthStatus) => void) => {
    const listener = (_: unknown, s: OAuthStatus) => cb(s);
    ipcRenderer.on(IpcEvents.oauthStatus, listener);
    return () => ipcRenderer.removeListener(IpcEvents.oauthStatus, listener);
  },
  onIndexProgress: (cb: (s: IndexStatus) => void) => {
    const listener = (_: unknown, s: IndexStatus) => cb(s);
    ipcRenderer.on(IpcEvents.indexProgress, listener);
    return () => ipcRenderer.removeListener(IpcEvents.indexProgress, listener);
  },
  onUpdateEvent: (cb: (u: UpdateInfo) => void) => {
    const listener = (_: unknown, u: UpdateInfo) => cb(u);
    ipcRenderer.on(IpcEvents.updateEvent, listener);
    return () => ipcRenderer.removeListener(IpcEvents.updateEvent, listener);
  },
  onTerminalEvent: (cb: (e: TerminalEvent) => void) => {
    const listener = (_: unknown, e: TerminalEvent) => cb(e);
    ipcRenderer.on(IpcEvents.terminalEvent, listener);
    return () => ipcRenderer.removeListener(IpcEvents.terminalEvent, listener);
  },
  onChangesUpdated: (cb: (e: { sessionId: string }) => void) => {
    const listener = (_: unknown, e: { sessionId: string }) => cb(e);
    ipcRenderer.on(IpcEvents.changesUpdated, listener);
    return () => ipcRenderer.removeListener(IpcEvents.changesUpdated, listener);
  },
  onTasksUpdated: (cb) => {
    const listener = (_: unknown, tasks: import('@agent-nekko/shared').AutomationTask[]) => cb(tasks);
    ipcRenderer.on(IpcEvents.tasksUpdated, listener);
    return () => ipcRenderer.removeListener(IpcEvents.tasksUpdated, listener);
  },
  onTrainingUpdated: (cb) => {
    const listener = (_: unknown, runs: import('@agent-nekko/shared').TrainingRun[]) => cb(runs);
    ipcRenderer.on(IpcEvents.trainingUpdated, listener);
    return () => ipcRenderer.removeListener(IpcEvents.trainingUpdated, listener);
  },
  onWorkflowsUpdated: (cb) => {
    const listener = (_: unknown, snapshot: import('@agent-nekko/shared').WorkflowsSnapshot) => cb(snapshot);
    ipcRenderer.on(IpcEvents.workflowsUpdated, listener);
    return () => ipcRenderer.removeListener(IpcEvents.workflowsUpdated, listener);
  },
  onLimitsUpdated: (cb: (e: { tokenKey: string; limits: SubscriptionLimits }) => void) => {
    const listener = (_: unknown, e: { tokenKey: string; limits: SubscriptionLimits }) => cb(e);
    ipcRenderer.on(IpcEvents.limitsUpdated, listener);
    return () => ipcRenderer.removeListener(IpcEvents.limitsUpdated, listener);
  },
  onDeepLink: (cb: (url: string) => void) => {
    const listener = (_: unknown, url: string) => cb(url);
    ipcRenderer.on(IpcEvents.deepLink, listener);
    return () => ipcRenderer.removeListener(IpcEvents.deepLink, listener);
  },
};

contextBridge.exposeInMainWorld('nekko', api);

/**
 * The window-chrome bridge, separate from the app API on purpose: `NekkoApi`
 * is the contract the web transport also implements, and a browser tab has no
 * title bar to draw. Its absence is how the renderer knows it isn't in the
 * desktop shell.
 */
const chrome: WindowChromeBridge = {
  platform: process.platform,
  titleBarHeight: TITLEBAR_HEIGHT,
  setTitleBarOverlay: (theme: TitleBarOverlayTheme) => ipcRenderer.send(TITLEBAR_OVERLAY_CHANNEL, theme),
};

contextBridge.exposeInMainWorld('nekkoChrome', chrome);
