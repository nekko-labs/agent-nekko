/** IPC channel contracts between renderer and main. */

import type { AppSettings, UsageSummary } from './settings.js';
import type { ProviderConfig, ModelInfo } from './models.js';
import type { Session, SendOptions, AgentEvent } from './chat.js';
import type { TerminalInfo, TerminalSnapshot, ShellOption } from './terminal.js';
import type { ContextBundle } from './context.js';
import type { MemoryEntry, MemoryScope } from './memory.js';
import type { WorkspaceFolder, IndexStatus, SearchHit, IndexedFile } from './workspace.js';
import type { DirEntry, FileContent, FileChange, LineComment } from './files.js';
import type { DesignBoard, DesignPage, GenerateDesignInput } from './design.js';
import type { AutomationTask, NewTask } from './tasks.js';
import type { TrainingRun, NewTrainingRun } from './training.js';
import type { NewWorkflow, Workflow, WorkflowEvent, WorkflowRun, WorkflowsSnapshot } from './workflows.js';
import type { ConnectorConfig, ConnectorKind, ConnectorResource } from './connectors.js';
import type { AgentToolId, AgentToolStatus, SubagentInstallResult, SubagentSnippet } from './integrations.js';
import type { GuardrailRule } from './guardrails.js';
import type { OAuthProvider, OAuthSessionInfo, OAuthStatus } from './oauth.js';
import type { SubscriptionLimits } from './limits.js';
import type { AppInfo, UpdateInfo } from './update.js';

/** Invoke (request/response) channels. */
export const IpcChannels = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  providersList: 'providers:list',
  providersSave: 'providers:save',
  providersRemove: 'providers:remove',
  providersDiscover: 'providers:discover',
  providersProbe: 'providers:probe',
  providersTest: 'providers:test',
  providersTestConfig: 'providers:testConfig',

  modelsList: 'models:list',
  modelPull: 'model:pull',
  modelLoad: 'model:load',
  modelUnload: 'model:unload',
  lmsProbe: 'lms:probe',
  serverStop: 'server:stop',
  runtimeStatus: 'runtime:status',
  runtimeStart: 'runtime:start',
  runtimeStop: 'runtime:stop',
  runtimeLoad: 'runtime:load',
  runtimeFacts: 'runtime:facts',
  runtimePlan: 'runtime:plan',
  machineReadiness: 'machine:readiness',
  gpuStats: 'gpu:stats',
  systemStats: 'system:stats',

  sessionsList: 'sessions:list',
  sessionCreate: 'session:create',
  sessionGet: 'session:get',
  sessionDelete: 'session:delete',
  sessionSetWorkspace: 'session:setWorkspace',
  sessionSetSupportingWorkspaces: 'session:setSupportingWorkspaces',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatQueue: 'chat:queue',
  chatDequeue: 'chat:dequeue',
  toolApprove: 'tool:approve',

  terminalsList: 'terminals:list',
  terminalShells: 'terminal:shells',
  terminalCreate: 'terminal:create',
  terminalSnapshot: 'terminal:snapshot',
  terminalUpdate: 'terminal:update',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalRun: 'terminal:run',
  terminalSignal: 'terminal:signal',
  terminalClose: 'terminal:close',

  contextPreview: 'context:preview',
  contextToggle: 'context:toggle',
  contextSetPrefs: 'context:setPrefs',
  sessionSetAttachments: 'session:setAttachments',
  specBuild: 'spec:build',
  specBuildDoc: 'spec:buildDoc',
  specReadDocs: 'spec:readDocs',
  specSetMethodology: 'spec:setMethodology',
  specToggleTask: 'spec:toggleTask',
  specSetLinked: 'spec:setLinked',
  specPath: 'spec:path',
  sessionSetOptions: 'session:setOptions',
  sessionTruncate: 'session:truncate',
  sessionsClear: 'sessions:clear',
  settingsReset: 'settings:reset',
  dataWipe: 'data:wipe',
  toolsList: 'tools:list',

  // Transport-local (handled by Electron main / web-client, not the host dispatcher)
  dialogOpenFiles: 'dialog:openFiles',
  openPath: 'shell:openPath',

  memoryList: 'memory:list',
  memorySave: 'memory:save',
  memoryDelete: 'memory:delete',

  workspaceList: 'workspace:list',
  workspaceAdd: 'workspace:add',
  workspaceAddByPath: 'workspace:addByPath',
  workspaceRemove: 'workspace:remove',
  workspaceIndex: 'workspace:index',
  workspaceIndexStatus: 'workspace:indexStatus',
  workspaceSearch: 'workspace:search',
  workspaceFiles: 'workspace:files',

  fileRead: 'file:read',
  fileWrite: 'file:write',
  dirList: 'dir:list',

  changesList: 'changes:list',
  changeAccept: 'changes:accept',
  changeAcceptAll: 'changes:acceptAll',

  prSessionList: 'pr:sessionList',
  prDiff: 'pr:diff',
  prAction: 'pr:action',

  commentsList: 'comments:list',
  commentAdd: 'comment:add',
  commentResolve: 'comment:resolve',

  designGet: 'design:get',
  designAddPage: 'design:addPage',
  designUpdatePage: 'design:updatePage',
  designRemovePage: 'design:removePage',
  designAddNote: 'design:addNote',
  designResolveNote: 'design:resolveNote',
  designGenerate: 'design:generate',

  skillsInstalled: 'skills:installed',
  skillsTargets: 'skills:targets',
  skillInstall: 'skill:install',
  skillUninstall: 'skill:uninstall',

  vaizerCatalog: 'vaizer:catalog',
  vaizerSkillMd: 'vaizer:skillMd',

  tasksList: 'tasks:list',
  taskCreate: 'task:create',
  taskUpdate: 'task:update',
  taskDelete: 'task:delete',
  taskRunNow: 'task:runNow',

  trainingList: 'training:list',
  trainingCreate: 'training:create',
  trainingUpdate: 'training:update',
  trainingDelete: 'training:delete',
  trainingStart: 'training:start',
  trainingPause: 'training:pause',
  trainingStop: 'training:stop',
  trainingHint: 'training:hint',

  workflowsList: 'workflows:list',
  workflowCreate: 'workflow:create',
  workflowUpdate: 'workflow:update',
  workflowDelete: 'workflow:delete',
  workflowDuplicate: 'workflow:duplicate',
  workflowRun: 'workflow:run',
  workflowCancel: 'workflow:cancel',
  workflowRuns: 'workflow:runs',
  /**
   * Feed an external event to the listeners. One door for every transport: the
   * CLI calls it directly, and the web edition's generic `/api/:channel` route
   * makes it the endpoint a Slack app or a git provider webhook posts to.
   */
  workflowEvent: 'workflow:event',

  connectorsList: 'connectors:list',
  connectorConnect: 'connector:connect',
  connectorDisconnect: 'connector:disconnect',
  connectorFetch: 'connector:fetch',

  integrationsDetect: 'integrations:detect',
  integrationsInstall: 'integrations:install',
  integrationsSnippet: 'integrations:snippet',

  guardrailsClassify: 'guardrails:classify',

  usageSummary: 'usage:summary',
  limitsGet: 'limits:get',

  oauthBegin: 'oauth:begin',
  oauthFinish: 'oauth:finish',
  oauthCancel: 'oauth:cancel',
  oauthStatus: 'oauth:status',
  oauthSignOut: 'oauth:signout',
  providersImportCliAuth: 'providers:importCliAuth',

  remoteEnable: 'remote:enable',
  remoteDisable: 'remote:disable',
  remoteStatus: 'remote:status',
  remotePairing: 'remote:pairing',
  remotePair: 'remote:pair',
  remoteDevices: 'remote:devices',
  remoteRevoke: 'remote:revoke',
  remoteRename: 'remote:rename',
  remoteRotate: 'remote:rotate',

  appInfo: 'app:info',
  mcpStatus: 'mcp:status',
  mcpHypergate: 'mcp:hypergate',
  mcpHypergateConnect: 'mcp:hypergate:connect',
  // Transport-local update controls (desktop = electron-updater, web = refresh).
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',

  dialogOpenFolder: 'dialog:openFolder',
} as const;

/** Push (main → renderer) channels. */
export const IpcEvents = {
  agentEvent: 'agent:event',
  oauthStatus: 'oauth:status',
  indexProgress: 'index:progress',
  updateEvent: 'update:event',
  terminalEvent: 'terminal:event',
  changesUpdated: 'changes:updated',
  tasksUpdated: 'tasks:updated',
  trainingUpdated: 'training:updated',
  workflowsUpdated: 'workflows:updated',
  limitsUpdated: 'limits:updated',
  deepLink: 'app:deepLink',
} as const;

/** The typed API the preload bridge exposes as window.nekko. */
export interface NekkoApi {
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;

  listProviders(): Promise<ProviderConfig[]>;
  saveProvider(p: ProviderConfig): Promise<ProviderConfig[]>;
  removeProvider(id: string): Promise<ProviderConfig[]>;
  discoverProviders(): Promise<ProviderConfig[]>;
  /**
   * Probe well-known localhost ports for running model servers WITHOUT saving
   * anything, unlike discoverProviders which merges hits into settings. The
   * onboarding wizard uses this so a skipped step stays non-destructive and the
   * user picks which detected server to add.
   */
  probeProviders(): Promise<ProviderConfig[]>;
  testProvider(id: string): Promise<{ ok: boolean; message: string }>;
  /** Test an unsaved provider config (used by the add form before saving). */
  testProviderConfig(cfg: ProviderConfig): Promise<{ ok: boolean; message: string }>;

  listModels(providerId: string): Promise<ModelInfo[]>;
  pullModel(providerId: string, model: string): Promise<{ ok: boolean; message: string }>;
  loadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  unloadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  /** Whether per-model load/unload is available for an LM Studio provider (via `lms`). */
  lmsAvailable(providerId: string): Promise<import('./models.js').LmsProbe>;
  /** Stop the local model server backing a provider (ollama/lmstudio/vllm/…). */
  stopServer(providerId: string): Promise<{ ok: boolean; message: string }>;

  /** Live state of a local runtime: health, ownership, resident models, metrics. */
  runtimeStatus(providerId: string): Promise<import('./runtimes.js').RuntimeStatus | null>;
  /** Start a local runtime we are able to start. Returns the reason when we are not. */
  runtimeStart(
    providerId: string,
  ): Promise<import('./runtimes.js').RuntimeStatus | { error: string }>;
  /**
   * Stop a local runtime. Without `force` this refuses a process Agent Nekko did
   * not start, returning `needsConfirmation` so the UI can ask first.
   */
  runtimeStop(providerId: string, force?: boolean): Promise<import('./runtimes.js').StopResult>;
  /** Load a model with explicit parameters (context, GPU layers, TTL). */
  runtimeLoad(
    providerId: string,
    modelId: string,
    params: import('./runtimes.js').LoadParams,
  ): Promise<import('./runtimes.js').LoadResult>;
  /** Model metadata normalized for the fit planner. */
  runtimeFacts(providerId: string): Promise<import('./capacity.js').ModelFacts[]>;
  /** Project whether a model fits at the given context/parallelism, and why. */
  runtimePlan(
    providerId: string,
    modelId: string,
    req: import('./capacity.js').FitRequest,
  ): Promise<import('./capacity.js').FitPlan | null>;
  /**
   * The AN9 machine-readiness report: probe this machine, evaluate it against
   * the versioned offline-stack catalog, and return per-role picks plus a
   * combined verdict. `unverified` means a needed probe did not answer.
   */
  machineReadiness(
    language?: string,
  ): Promise<import('./readiness.js').ReadinessReport>;
  /** GPU/VRAM stats for the metrics bar + Command Center (null if unavailable). */
  getGpuStats(): Promise<import('./models.js').GpuStats | null>;
  /** CPU load + RAM use for the monitor surfaces (null if unavailable). */
  getSystemStats(): Promise<import('./monitor.js').SystemStats | null>;

  listSessions(): Promise<Session[]>;
  createSession(workspaceId?: string): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  setSessionWorkspace(sessionId: string, workspaceId?: string): Promise<Session | null>;
  setSessionSupportingWorkspaces(sessionId: string, workspaceIds: string[]): Promise<Session | null>;
  setSessionAttachments(sessionId: string, paths: string[]): Promise<Session | null>;
  sendChat(opts: SendOptions): Promise<void>;
  abortChat(sessionId: string): Promise<void>;
  /** Append a prompt to a chat's run-queue (runs when the current turn ends). */
  queuePrompt(sessionId: string, text: string): Promise<Session | null>;
  /** Remove a queued prompt by index. */
  dequeuePrompt(sessionId: string, index: number): Promise<Session | null>;
  approveTool(sessionId: string, toolCallId: string, approved: boolean): Promise<void>;

  /** Live terminal sessions (in-memory; they don't persist across restarts). */
  listTerminals(): Promise<TerminalInfo[]>;
  /** Shells the host detected as available to launch. */
  listShells(): Promise<ShellOption[]>;
  /** Spawn a PTY-backed shell, optionally scoped to a project / cwd / shell. */
  createTerminal(opts?: { workspaceId?: string; cwd?: string; title?: string; shell?: string; cols?: number; rows?: number }): Promise<TerminalInfo>;
  /** Fetch current info + retained raw scrollback (for reattaching a renderer). */
  terminalSnapshot(id: string): Promise<TerminalSnapshot | null>;
  /** Update a terminal's project/order (sidebar drag-and-drop). */
  updateTerminal(id: string, patch: { workspaceId?: string | null; order?: number; title?: string }): Promise<void>;
  /** Write raw input (keystrokes) to the PTY. */
  writeTerminal(id: string, data: string): Promise<void>;
  /** Tell the PTY its new viewport size so the shell reflows. */
  resizeTerminal(id: string, cols: number, rows: number): Promise<void>;
  /** Convenience: write a command line followed by Enter. */
  runInTerminal(id: string, command: string): Promise<void>;
  /** Send a control signal (e.g. interrupt → Ctrl-C). */
  signalTerminal(id: string, signal: 'interrupt'): Promise<void>;
  /** Kill the shell and forget the terminal. */
  closeTerminal(id: string): Promise<void>;

  previewContext(sessionId: string, attachedPaths: string[]): Promise<ContextBundle>;
  toggleContextItem(sessionId: string, itemId: string, included: boolean, pinned: boolean): Promise<ContextBundle>;
  setContextPrefs(sessionId: string, prefs: import('./chat.js').ContextPrefs): Promise<void>;

  /** Build/refresh the primary spec doc in the chat's workspace from the conversation. */
  buildSpec(sessionId: string): Promise<{ ok: boolean; path?: string; message?: string }>;
  /** Build/refresh one artifact (by id) of the chat's spec methodology. */
  buildSpecDoc(sessionId: string, docId?: string, workspaceId?: string): Promise<{ ok: boolean; path?: string; docId?: string; message?: string }>;
  /** Read the live status of every artifact in the chat's spec methodology. */
  readSpecDocs(sessionId: string, workspaceId?: string): Promise<{ methodologyId: string; docs: import('./spec.js').SpecDocStatus[] }>;
  /** Set the spec methodology for a chat. */
  setSpecMethodology(sessionId: string, methodologyId: string): Promise<void>;
  /** Toggle a checklist item in the chat's tasks artifact. */
  toggleSpecTask(sessionId: string, lineIndex: number, workspaceId?: string): Promise<{ ok: boolean; message?: string }>;
  setSpecLinked(sessionId: string, linked: boolean): Promise<Session | null>;
  specPath(sessionId: string): Promise<string | null>;
  setSessionOptions(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'order' | 'mode' | 'disabledTools' | 'offline' | 'incognito' | 'autoModel' | 'autoQuality' | 'thinking' | 'providerId' | 'modelId'>>,
  ): Promise<Session | null>;
  truncateSession(id: string, messageId: string): Promise<Session | null>;
  /** Delete chats within a window; returns how many were removed. */
  clearSessions(scope: import('./chat.js').ChatClearScope): Promise<number>;
  /** Reset all settings to defaults (keeps chats). */
  resetSettings(): Promise<AppSettings>;
  /** Delete everything: chats, settings, memory, and usage. */
  wipeAllData(): Promise<AppSettings>;
  listTools(): Promise<Array<{ name: string; description: string }>>;

  /** Open a native file picker (desktop) → chosen paths; browser → prompt. */
  openFilesDialog(): Promise<string[]>;
  /** Reveal/open a path with the OS (desktop) or a URL (web). */
  openPath(path: string): Promise<void>;

  listMemory(scope: MemoryScope, workspaceId?: string): Promise<MemoryEntry[]>;
  saveMemory(entry: MemoryEntry): Promise<MemoryEntry[]>;
  deleteMemory(id: string): Promise<void>;

  listWorkspaces(): Promise<WorkspaceFolder[]>;
  addWorkspace(): Promise<WorkspaceFolder[]>;
  addWorkspaceByPath(path: string): Promise<WorkspaceFolder[]>;
  removeWorkspace(id: string): Promise<WorkspaceFolder[]>;
  indexWorkspace(id: string): Promise<IndexStatus>;
  getIndexStatus(id: string): Promise<IndexStatus | null>;
  searchWorkspace(id: string, query: string): Promise<SearchHit[]>;
  listFiles(id: string): Promise<IndexedFile[]>;

  /** Read a file as text (for the in-app viewer/editor). */
  readFile(path: string): Promise<FileContent>;
  /** Write text to a file (in-app editor save). */
  writeFile(path: string, content: string): Promise<void>;
  /** List a directory's immediate entries (file explorer). */
  listDir(path: string): Promise<DirEntry[]>;

  /** Files the agent changed this session (diff/approve). */
  listChanges(sessionId: string): Promise<FileChange[]>;
  /** Keep a file's changes, stop tracking it. */
  acceptChange(sessionId: string, path: string): Promise<void>;
  /** Keep all of a session's changes. */
  acceptAllChanges(sessionId: string): Promise<void>;

  /** Live PR state for every GitHub PR URL referenced in a chat's transcript. */
  listSessionPrs(sessionId: string): Promise<import('./pr.js').PrInfo[]>;
  /** A PR's changed files + patches (for the diff pane). */
  getPrDiff(url: string): Promise<import('./pr.js').PrDiff>;
  /** Approve / decline / merge / reopen a PR. Always user-initiated. */
  prAction(url: string, action: import('./pr.js').PrAction): Promise<import('./pr.js').PrActionResult>;

  /** Inline editor comments on a file (gutter "+" annotations the agent picks up). */
  listComments(path: string): Promise<LineComment[]>;
  addComment(path: string, line: number, lineText: string, comment: string): Promise<LineComment[]>;
  resolveComment(path: string, id: string): Promise<LineComment[]>;

  /** Design board: a workspace's UI page snapshots + persistent notes. */
  getDesignBoard(workspaceId: string): Promise<DesignBoard>;
  addDesignPage(workspaceId: string, label: string, url: string): Promise<DesignBoard>;
  updateDesignPage(workspaceId: string, pageId: string, patch: Partial<Pick<DesignPage, 'label' | 'url'>>): Promise<DesignBoard>;
  removeDesignPage(workspaceId: string, pageId: string): Promise<DesignBoard>;
  addDesignNote(workspaceId: string, pageId: string, text: string): Promise<DesignBoard>;
  resolveDesignNote(workspaceId: string, pageId: string, noteId: string): Promise<DesignBoard>;
  /** Generate (or refine) an AI design concept from a prompt and/or a sketch. */
  generateDesign(workspaceId: string, input: GenerateDesignInput): Promise<DesignBoard>;

  /** Skills marketplace: what's installed, where installs can go, install/remove. */
  listInstalledSkills(): Promise<import('./skills-market.js').InstalledSkillRecord[]>;
  skillTargets(): Promise<import('./skills-market.js').InstallTargetInfo[]>;
  installSkill(
    skillId: string,
    target: import('./skills-market.js').InstallTarget,
    payload?: import('./skills-market.js').MarketplaceSkill,
  ): Promise<{ ok: boolean; message?: string; installed: import('./skills-market.js').InstalledSkillRecord[] }>;
  uninstallSkill(
    skillId: string,
    target: import('./skills-market.js').InstallTarget,
  ): Promise<import('./skills-market.js').InstalledSkillRecord[]>;
  /** Vaizer skills hub (optional integration): catalog + SKILL.md fetch. */
  vaizerCatalog(refresh?: boolean): Promise<import('./vaizer.js').VaizerCatalog>;
  vaizerSkillMd(slug: string): Promise<string | null>;

  /** Automation tasks: scheduled, recurring, and long-running background agents. */
  listTasks(): Promise<AutomationTask[]>;
  createTask(task: NewTask): Promise<AutomationTask[]>;
  updateTask(id: string, patch: Partial<AutomationTask>): Promise<AutomationTask[]>;
  deleteTask(id: string): Promise<AutomationTask[]>;
  runTaskNow(id: string): Promise<void>;

  /** Training/goal runs: the data-scientist agent + experiment tree engine. */
  listTrainingRuns(): Promise<TrainingRun[]>;
  createTrainingRun(input: NewTrainingRun): Promise<TrainingRun>;
  updateTrainingRun(id: string, patch: Partial<TrainingRun>): Promise<TrainingRun[]>;
  deleteTrainingRun(id: string): Promise<TrainingRun[]>;
  startTrainingRun(id: string): Promise<TrainingRun[]>;
  pauseTrainingRun(id: string): Promise<TrainingRun[]>;
  stopTrainingRun(id: string): Promise<TrainingRun[]>;
  /** Inject a hint / new approach / new-data pointer into the next turn. */
  addTrainingHint(id: string, text: string): Promise<TrainingRun[]>;

  /** Workflows: GitHub-Actions-style automation with routed steps and triggers. */
  listWorkflows(): Promise<WorkflowsSnapshot>;
  createWorkflow(input: NewWorkflow): Promise<Workflow | undefined>;
  updateWorkflow(id: string, patch: Partial<Workflow>): Promise<Workflow | undefined>;
  deleteWorkflow(id: string): Promise<WorkflowsSnapshot>;
  duplicateWorkflow(id: string): Promise<Workflow | undefined>;
  /** Start a workflow by hand; resolves when the run finishes. */
  runWorkflow(id: string): Promise<WorkflowRun | undefined>;
  /** Stop a run in progress (aborts whatever step is mid-flight). */
  cancelWorkflowRun(runId: string): Promise<void>;
  /** Run history, newest first, for one workflow or all of them. */
  listWorkflowRuns(workflowId?: string): Promise<WorkflowRun[]>;
  /** Offer an event to every listening workflow; returns the runs it started. */
  dispatchWorkflowEvent(event: WorkflowEvent): Promise<WorkflowRun[]>;

  listConnectors(): Promise<ConnectorConfig[]>;
  connectConnector(kind: ConnectorKind, token: string, settings?: Record<string, string>): Promise<ConnectorConfig[]>;
  disconnectConnector(kind: ConnectorKind): Promise<ConnectorConfig[]>;
  fetchConnector(kind: ConnectorKind, query?: string): Promise<ConnectorResource[]>;

  /** Which agent CLIs are present and whether Nekko is installed as an MCP subagent. */
  detectAgentTools(): Promise<AgentToolStatus[]>;
  /** Merge the agent-nekko MCP entry into a tool's config (backs up to <file>.bak first). */
  installSubagent(tool: AgentToolId): Promise<SubagentInstallResult>;
  /** The manual copy-paste config for a tool (target path + snippet). */
  subagentSnippet(tool: AgentToolId): Promise<SubagentSnippet>;

  classifyCommand(command: string): Promise<import('./guardrails.js').GuardrailDecision>;
  saveGuardrail(rule: GuardrailRule): Promise<GuardrailRule[]>;

  getUsageSummary(): Promise<UsageSummary>;
  getLimits(tokenKey: string): Promise<SubscriptionLimits | undefined>;

  oauthBegin(provider: OAuthProvider): Promise<OAuthSessionInfo>;
  oauthFinish(sessionId: string, pasted: string): Promise<OAuthStatus>;
  oauthCancel(sessionId: string): Promise<void>;
  oauthStatus(providerConfigId: string): Promise<OAuthStatus>;
  oauthSignOut(providerConfigId: string): Promise<void>;
  /** Import tokens from the official CLI credential files without returning the secrets. */
  importCliAuth(): Promise<{ claude: boolean; chatgpt: boolean }>;

  enableRemote(relayUrl: string): Promise<import('./remote.js').RemoteStatus>;
  disableRemote(): Promise<import('./remote.js').RemoteStatus>;
  getRemoteStatus(): Promise<import('./remote.js').RemoteStatus>;
  getRemotePairing(): Promise<import('./remote.js').RemotePairing | null>;
  /** Mint a short-lived single-use pairing code for enrolling a new device. */
  startRemotePairing(): Promise<import('./remote.js').PairingGrant>;
  listRemoteDevices(): Promise<import('./remote.js').RemoteDevice[]>;
  revokeRemoteDevice(deviceId: string): Promise<import('./remote.js').RemoteDevice[]>;
  renameRemoteDevice(deviceId: string, name: string): Promise<import('./remote.js').RemoteDevice[]>;
  /** Rotate the pairing secret: re-keys the room; every device must re-pair. */
  rotateRemoteSecret(): Promise<import('./remote.js').RemoteStatus>;

  /** Running version + edition. */
  getAppInfo(): Promise<AppInfo>;
  /** Connect configured MCP servers and return their status + tools. */
  getMcpStatus(): Promise<import('./mcp.js').McpServerStatus[]>;
  /** Probe for a local Hypergate daemon (`hypergated`) and return its gateway info. */
  detectHypergate(port?: number): Promise<import('./mcp.js').HypergateInfo | null>;
  /** Connect to a local Hypergate daemon: claim a token, save the entry, bring its tools online. */
  connectHypergate(port?: number): Promise<import('./mcp.js').HypergateInfo | null>;
  /** Register this device's push token with the relay (mobile/relay only; no-op elsewhere). */
  registerPushToken(token: string, platform: 'ios' | 'android'): Promise<void>;
  /** Check for a newer version (desktop: GitHub feed; web: server version). */
  checkForUpdates(): Promise<UpdateInfo>;
  /** Download the available update (desktop only; web resolves immediately). */
  downloadUpdate(): Promise<UpdateInfo>;
  /** Install + relaunch (desktop) or reload the page (web). */
  quitAndInstall(): Promise<void>;

  onAgentEvent(cb: (e: AgentEvent) => void): () => void;
  onOAuthStatus(cb: (s: OAuthStatus) => void): () => void;
  onIndexProgress(cb: (s: IndexStatus) => void): () => void;
  onUpdateEvent(cb: (u: UpdateInfo) => void): () => void;
  onTerminalEvent(cb: (e: import('./terminal.js').TerminalEvent) => void): () => void;
  /** Fires when a session's tracked file changes shift (after an agent edit/accept). */
  onChangesUpdated(cb: (e: { sessionId: string }) => void): () => void;
  /** Fires when the automation-task list changes (created/updated/fired/deleted). */
  onTasksUpdated(cb: (tasks: AutomationTask[]) => void): () => void;
  /** Fires when any training/goal run changes (experiments, hints, status). */
  onTrainingUpdated(cb: (runs: TrainingRun[]) => void): () => void;
  /** Fires when a workflow is edited or any run advances a step. */
  onWorkflowsUpdated(cb: (snapshot: WorkflowsSnapshot) => void): () => void;
  /** Fires when subscription limits are captured or polled for any token key. */
  onLimitsUpdated(cb: (e: { tokenKey: string; limits: SubscriptionLimits }) => void): () => void;
  /**
   * Fires when another app asks Kotrain to do something through a `kotrain://`
   * URL: today, Hypergate's "Connect Kotrain" button. Desktop only, since the
   * web transport has no OS to hand it one.
   */
  onDeepLink(cb: (url: string) => void): () => void;
}
