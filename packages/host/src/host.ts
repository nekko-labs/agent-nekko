import { EventEmitter } from 'events';
import { basename } from 'path';
import type {
  AppSettings,
  ProviderConfig,
  ModelInfo,
  ModelFacts,
  FitPlan,
  FitRequest,
  RuntimeStatus,
  StopResult,
  LoadParams,
  LoadResult,
  Session,
  SendOptions,
  OAuthProvider,
  OAuthSessionInfo,
  OAuthStatus,
  ContextBundle,
  MemoryEntry,
  MemoryScope,
  WorkspaceFolder,
  IndexStatus,
  SearchHit,
  IndexedFile,
  DirEntry,
  FileContent,
  FileChange,
  PrInfo,
  PrDiff,
  PrAction,
  PrActionResult,
  LineComment,
  DesignBoard,
  DesignPage,
  GenerateDesignInput,
  AutomationTask,
  NewTask,
  TrainingRun,
  NewTrainingRun,
  Workflow,
  NewWorkflow,
  WorkflowEvent,
  WorkflowRun,
  WorkflowsSnapshot,
  InstalledSkillRecord,
  InstallTargetInfo,
  InstallTarget,
  ConnectorConfig,
  ConnectorKind,
  ConnectorResource,
  AgentToolId,
  AgentToolStatus,
  SubagentInstallResult,
  SubagentSnippet,
  GuardrailDecision,
  UsageSummary,
  RemoteStatus,
  AppInfo,
  McpServerStatus,
  SpecDocStatus,
  TerminalInfo,
  TerminalSnapshot,
  ShellOption,
  GpuStats,
  SystemStats,
  LmsProbe,
  SubscriptionLimits,
  ReadinessReport,
  AutoFitSummary,
  CatalogModel,
  DownloadJob,
  EngineLoadPreset,
  EngineSettings,
  EngineStatus,
  LocalModel,
} from '@agent-nekko/shared';
import { brandEnv, DEFAULT_ENGINE_SETTINGS, engineBaseUrl, isLocalProvider, isRuntimeKind } from '@agent-nekko/shared';
import { gatherMachineFacts } from './readiness.js';
import { createRuntimes } from './runtimes/index.js';
import { createEngine } from './engine/index.js';
import {
  createProvider,
  discoverLocalProviders,
  OllamaProvider,
  getConnector,
  classifyCommand,
  BUILTIN_TOOLS,
  evaluateReadiness,
  OFFLINE_STACK_CATALOG,
} from '@agent-nekko/core';
import { setDataDir, dataDir } from './paths.js';
import { getSettings, saveSettings, resetSettings } from './store.js';
import * as sessions from './sessions.js';
import * as memory from './memory.js';
import { usageSummary, clearUsage } from './usage.js';
import { indexWorkspace, getIndexStatus, searchWorkspace, listIndexedFiles } from './workspace.js';
import { readFile, writeFile, listDir } from './files.js';
import { listChanges, acceptChange, acceptAllChanges, setChangeNotifier } from './changes.js';
import { listSessionPrs, getPrDiff, prAction } from './pr.js';
import { listComments, addComment, resolveComment } from './comments.js';
import {
  getDesignBoard,
  addDesignPage,
  updateDesignPage,
  removeDesignPage,
  addDesignNote,
  resolveDesignNote,
  generateDesign,
} from './design.js';
import { listInstalledSkills, skillTargets, installSkill, uninstallSkill } from './skills.js';
import { getVaizerCatalog, getVaizerSkillMd } from './vaizer.js';
import {
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  runTaskNow,
  setTaskSender,
  setTasksNotifier,
  startTaskScheduler,
} from './tasks.js';
import {
  listTrainingRuns,
  createTrainingRun,
  updateTrainingRun,
  deleteTrainingRun,
  startTrainingRun,
  pauseTrainingRun,
  stopTrainingRun,
  addTrainingHint,
  setTrainingSender,
  setTrainingNotifier,
  startTrainingScheduler,
} from './training.js';
import {
  listWorkflowRuns,
  workflowsSnapshot,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  duplicateWorkflow,
  runWorkflow,
  cancelWorkflowRun,
  dispatchWorkflowEvent,
  dispatchWebhook,
  setWorkflowSender,
  setWorkflowsNotifier,
  startWorkflowScheduler,
  reconcileWorkflowRuns,
} from './workflows.js';
import { sendChat, abortChat, resolveApproval, previewContext, setContextPrefs } from './chat.js';
import { initLimits, getLimits, clearLimits } from './limits.js';
import { startWorkflowListeners } from './listeners.js';
import {
  initOAuth,
  beginOAuth,
  finishOAuth,
  cancelOAuth,
  getOAuthStatus,
  signOut as signOutOAuth,
  importCliAuth,
  resolveSubscriptionProvider,
} from './oauth.js';
import { buildSpec, buildSpecDoc, readSpecDocs, setSpecMethodology, toggleSpecTask, specPathForSession } from './spec.js';
import { createRemoteService } from './remote.js';
import { detectAgentTools, installSubagent, subagentSnippet } from './integrations.js';
import { getGpuStats, getGpuStatsFresh } from './gpu.js';
import { getSystemStats } from './system.js';
import { stopLocalServer } from './servers.js';
import { lmsProbe, lmsLoad, lmsUnload } from './lms.js';
import { syncMcp, mcpStatus, mcpToolList, detectHypergate, resolveHypergate, withHypergate } from './mcp.js';
import {
  setTerminalSender,
  listTerminals,
  listShells,
  createTerminal,
  terminalSnapshot,
  writeTerminal,
  resizeTerminal,
  runInTerminal,
  signalTerminal,
  closeTerminal,
  updateTerminal,
} from './terminal.js';
import { randomUUID } from 'crypto';

/**
 * The transport-agnostic host. `createHost()` returns an object implementing the
 * full NekkoApi surface (sans the renderer-side `on*` subscriptions, which are
 * served by `events`) plus a couple of methods the UI layer drives differently
 * per runtime (e.g. `addWorkspaceByPath`, since Electron uses a native dialog
 * while the web server takes a path string).
 *
 * Every edition, Electron, the web server, Agent Nekko Cloud, wraps the same Host.
 */
export interface Host {
  /** Emits 'agentEvent' (AgentEvent) and 'indexProgress' (IndexStatus). */
  readonly events: EventEmitter;
  dataDir(): string;

  getSettings(): AppSettings;
  updateSettings(patch: Partial<AppSettings>): AppSettings;

  listProviders(): ProviderConfig[];
  saveProvider(p: ProviderConfig): ProviderConfig[];
  removeProvider(id: string): ProviderConfig[];
  discoverProviders(): Promise<ProviderConfig[]>;
  /** Probe localhost for running model servers without persisting (onboarding). */
  probeProviders(): Promise<ProviderConfig[]>;
  testProvider(id: string): Promise<{ ok: boolean; message: string }>;
  testProviderConfig(cfg: ProviderConfig): Promise<{ ok: boolean; message: string }>;

  listModels(providerId: string): Promise<ModelInfo[]>;
  pullModel(providerId: string, model: string): Promise<{ ok: boolean; message: string }>;
  loadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  unloadModel(providerId: string, model: string): Promise<{ ok: boolean; message?: string }>;
  /** Whether per-model load/unload is available for an LM Studio provider (via `lms`). */
  lmsAvailable(providerId: string): Promise<LmsProbe>;
  runtimeStatus(providerId: string): Promise<RuntimeStatus | null>;
  runtimeStart(providerId: string): Promise<RuntimeStatus | { error: string }>;
  runtimeStop(providerId: string, force?: boolean): Promise<StopResult>;
  runtimeLoad(providerId: string, modelId: string, params: LoadParams): Promise<LoadResult>;
  runtimeFacts(providerId: string): Promise<ModelFacts[]>;
  runtimePlan(providerId: string, modelId: string, req: FitRequest): Promise<FitPlan | null>;
  runtimeAutoFit(
    providerId: string,
    modelId: string,
    budgetFraction: number,
    parallelSlots?: number,
  ): Promise<AutoFitSummary | null>;

  /** The built-in engine: install, catalog, library, and its own server. */
  engineStatus(): Promise<EngineStatus>;
  engineInstall(buildId?: string): Promise<{ ok: boolean; message: string; jobId?: string }>;
  engineUninstall(): Promise<{ ok: boolean; message: string }>;
  engineSettingsSave(patch: Partial<EngineSettings>): Promise<EngineSettings>;
  engineModels(): Promise<Array<LocalModel & { loaded: boolean }>>;
  engineImportModel(path: string): Promise<{ ok: boolean; message: string; model?: LocalModel }>;
  engineDeleteModel(id: string): Promise<{ ok: boolean; message: string }>;
  engineSaveModelPreset(id: string, preset: EngineLoadPreset): Promise<void>;
  engineCatalog(query?: string): Promise<CatalogModel[]>;
  engineCatalogModel(id: string): Promise<CatalogModel | null>;
  engineDownloadModel(modelId: string, quantLabel: string): Promise<{ ok: boolean; message: string; jobId?: string }>;
  engineDownloads(): Promise<DownloadJob[]>;
  engineCancelDownload(id: string): Promise<void>;
  engineDismissDownload(id: string): Promise<void>;
  /**
   * The AN9b machine-readiness report: probe this machine and evaluate it
   * against the versioned offline-stack catalog (runtime + intent + STT + TTS).
   */
  machineReadiness(language?: string): Promise<ReadinessReport>;
  /** Stop the local model server backing a provider (kills its listening process). */
  stopServer(providerId: string): Promise<{ ok: boolean; message: string }>;
  /** GPU stats from the platform's probe (null when it can't read one). */
  getGpuStats(): Promise<GpuStats | null>;
  /** CPU load + RAM use for the resource monitors. */
  getSystemStats(): Promise<SystemStats | null>;

  listSessions(): Session[];
  createSession(workspaceId?: string): Session;
  getSession(id: string): Session | null;
  deleteSession(id: string): void;
  setSessionWorkspace(id: string, workspaceId?: string): Session | null;
  setSessionSupportingWorkspaces(id: string, workspaceIds: string[]): Session | null;
  setSessionAttachments(id: string, paths: string[]): Session | null;
  sendChat(opts: SendOptions): Promise<void>;
  abortChat(sessionId: string): void;
  queuePrompt(sessionId: string, text: string): Session | null;
  dequeuePrompt(sessionId: string, index: number): Session | null;
  approveTool(sessionId: string, toolCallId: string, approved: boolean): void;

  listTerminals(): TerminalInfo[];
  listShells(): ShellOption[];
  createTerminal(opts?: { workspaceId?: string; cwd?: string; title?: string; shell?: string; cols?: number; rows?: number }): TerminalInfo;
  terminalSnapshot(id: string): TerminalSnapshot | null;
  updateTerminal(id: string, patch: { workspaceId?: string | null; order?: number; title?: string }): void;
  writeTerminal(id: string, data: string): void;
  resizeTerminal(id: string, cols: number, rows: number): void;
  runInTerminal(id: string, command: string): void;
  signalTerminal(id: string, signal: 'interrupt'): void;
  closeTerminal(id: string): void;

  previewContext(sessionId: string, attachedPaths: string[]): Promise<ContextBundle>;
  setContextPrefs(sessionId: string, prefs: { excluded: string[]; pinned: string[] }): void;

  buildSpec(sessionId: string): Promise<{ ok: boolean; path?: string; message?: string }>;
  buildSpecDoc(sessionId: string, docId?: string, workspaceId?: string): Promise<{ ok: boolean; path?: string; docId?: string; message?: string }>;
  readSpecDocs(sessionId: string, workspaceId?: string): { methodologyId: string; docs: SpecDocStatus[] };
  setSpecMethodology(sessionId: string, methodologyId: string): void;
  toggleSpecTask(sessionId: string, lineIndex: number, workspaceId?: string): { ok: boolean; message?: string };
  setSpecLinked(sessionId: string, linked: boolean): Session | null;
  specPath(sessionId: string): string | null;
  setSessionOptions(
    id: string,
    patch: Partial<Pick<Session, 'title' | 'pinned' | 'tags' | 'mode' | 'disabledTools' | 'offline' | 'incognito' | 'autoModel' | 'autoQuality' | 'thinking' | 'providerId' | 'modelId' | 'plan'>>,
  ): Session | null;
  truncateSession(id: string, messageId: string): Session | null;
  clearSessions(scope: 'today' | 'month' | 'all'): number;
  resetSettings(): AppSettings;
  wipeAllData(): AppSettings;
  listTools(): Array<{ name: string; description: string }>;

  listMemory(scope: MemoryScope, workspaceId?: string): MemoryEntry[];
  saveMemory(entry: MemoryEntry): MemoryEntry[];
  deleteMemory(id: string): void;

  listWorkspaces(): WorkspaceFolder[];
  addWorkspaceByPath(path: string): WorkspaceFolder[];
  removeWorkspace(id: string): WorkspaceFolder[];
  indexWorkspace(id: string): IndexStatus;
  getIndexStatus(id: string): IndexStatus | null;
  searchWorkspace(id: string, query: string): SearchHit[];
  listFiles(id: string): IndexedFile[];

  readFile(path: string): FileContent;
  writeFile(path: string, content: string): void;
  listDir(path: string): DirEntry[];

  /** Files the agent changed this session (for diff/approve). */
  listChanges(sessionId: string): FileChange[];
  /** Keep a file's changes, stop tracking it. */
  acceptChange(sessionId: string, path: string): void;
  /** Keep all of a session's changes. */
  acceptAllChanges(sessionId: string): void;

  /** Live PR state for every PR URL referenced in a chat's transcript. */
  listSessionPrs(sessionId: string): Promise<PrInfo[]>;
  /** A PR's changed files + patches (diff pane). */
  getPrDiff(url: string): Promise<PrDiff>;
  /** Approve / decline / merge / reopen a PR (user-initiated). */
  prAction(url: string, action: PrAction): Promise<PrActionResult>;

  /** Inline editor comments on a file. */
  listComments(path: string): LineComment[];
  addComment(path: string, line: number, lineText: string, comment: string): LineComment[];
  resolveComment(path: string, id: string): LineComment[];

  /** Design board: a workspace's UI page snapshots + persistent notes. */
  getDesignBoard(workspaceId: string): DesignBoard;
  addDesignPage(workspaceId: string, label: string, url: string): DesignBoard;
  updateDesignPage(workspaceId: string, pageId: string, patch: Partial<Pick<DesignPage, 'label' | 'url'>>): DesignBoard;
  removeDesignPage(workspaceId: string, pageId: string): DesignBoard;
  addDesignNote(workspaceId: string, pageId: string, text: string): DesignBoard;
  resolveDesignNote(workspaceId: string, pageId: string, noteId: string): DesignBoard;
  generateDesign(workspaceId: string, input: GenerateDesignInput): Promise<DesignBoard>;

  /** Skills marketplace installs. */
  listInstalledSkills(): InstalledSkillRecord[];
  skillTargets(): InstallTargetInfo[];
  installSkill(
    skillId: string,
    target: InstallTarget,
    payload?: import('@agent-nekko/shared').MarketplaceSkill,
  ): { ok: boolean; message?: string; installed: InstalledSkillRecord[] };
  uninstallSkill(skillId: string, target: InstallTarget): InstalledSkillRecord[];
  /** Vaizer skills hub (optional): catalog + a skill's SKILL.md. */
  vaizerCatalog(refresh?: boolean): Promise<import('@agent-nekko/shared').VaizerCatalog>;
  vaizerSkillMd(slug: string): Promise<string | null>;

  /** Automation tasks: scheduled, recurring, and long-running background agents. */
  listTasks(): AutomationTask[];
  createTask(task: NewTask): AutomationTask[];
  updateTask(id: string, patch: Partial<AutomationTask>): AutomationTask[];
  deleteTask(id: string): AutomationTask[];
  runTaskNow(id: string): void;

  /** Training/goal runs: the data-scientist agent + experiment-tree engine. */
  listTrainingRuns(): TrainingRun[];
  createTrainingRun(input: NewTrainingRun): TrainingRun;
  updateTrainingRun(id: string, patch: Partial<TrainingRun>): TrainingRun[];
  deleteTrainingRun(id: string): TrainingRun[];
  startTrainingRun(id: string): TrainingRun[];
  pauseTrainingRun(id: string): TrainingRun[];
  stopTrainingRun(id: string): TrainingRun[];
  addTrainingHint(id: string, text: string): TrainingRun[];

  listWorkflows(): WorkflowsSnapshot;
  createWorkflow(input: NewWorkflow): Workflow;
  updateWorkflow(id: string, patch: Partial<Workflow>): Workflow | undefined;
  deleteWorkflow(id: string): WorkflowsSnapshot;
  duplicateWorkflow(id: string): Workflow | undefined;
  runWorkflow(id: string): Promise<WorkflowRun | undefined>;
  cancelWorkflowRun(runId: string): void;
  listWorkflowRuns(workflowId?: string): WorkflowRun[];
  dispatchWorkflowEvent(event: WorkflowEvent): Promise<WorkflowRun[]>;
  dispatchWebhook(slug: string, secret: string, payload: Record<string, unknown>): Promise<WorkflowRun[]>;

  listConnectors(): ConnectorConfig[];
  connectConnector(kind: ConnectorKind, token: string, settings?: Record<string, string>): ConnectorConfig[];
  disconnectConnector(kind: ConnectorKind): ConnectorConfig[];
  fetchConnector(kind: ConnectorKind, query?: string): Promise<ConnectorResource[]>;

  /** Which agent CLIs are present and whether Nekko is installed as a subagent. */
  detectAgentTools(): AgentToolStatus[];
  /** Merge the agent-nekko MCP entry into a tool's config (backs up first). */
  installSubagent(tool: AgentToolId): SubagentInstallResult;
  /** The manual copy-paste config for a tool. */
  subagentSnippet(tool: AgentToolId): SubagentSnippet;

  classifyCommand(command: string): GuardrailDecision;
  usageSummary(): UsageSummary;
  getLimits(tokenKey: string): Promise<SubscriptionLimits | undefined>;

  /** Expose this machine over a relay so paired devices can reach it. */
  enableRemote(relayUrl: string): RemoteStatus;
  disableRemote(): RemoteStatus;
  remoteStatus(): RemoteStatus;
  remotePairing(): import('@agent-nekko/shared').RemotePairing | null;
  startRemotePairing(): import('@agent-nekko/shared').PairingGrant;
  listRemoteDevices(): import('@agent-nekko/shared').RemoteDevice[];
  revokeRemoteDevice(deviceId: string): import('@agent-nekko/shared').RemoteDevice[];
  renameRemoteDevice(deviceId: string, name: string): import('@agent-nekko/shared').RemoteDevice[];
  rotateRemoteSecret(): RemoteStatus;
  /** The remote-access service itself (headless relay-agent mode attaches here). */
  remote: import('./remote.js').RemoteService;

  beginOAuth(provider: OAuthProvider): Promise<OAuthSessionInfo>;
  finishOAuth(sessionId: string, pasted: string): Promise<OAuthStatus>;
  cancelOAuth(sessionId: string): Promise<void>;
  oauthStatus(providerConfigId: string): Promise<OAuthStatus>;
  oauthSignOut(providerConfigId: string): Promise<void>;
  importCliAuth(): Promise<{ claude: boolean; chatgpt: boolean }>;

  appInfo(): AppInfo;
  /** Connect (or reconnect) configured MCP servers and return their status. */
  mcpStatus(): Promise<McpServerStatus[]>;
  /** Probe for a local Hypergate daemon and return its gateway info (no side effects). */
  detectHypergate(port?: number): Promise<import('@agent-nekko/shared').HypergateInfo | null>;
  /**
   * Connect this install to a local Hypergate daemon in one step: probe it,
   * claim this install's scoped agent token, save the MCP entry, and bring its
   * tools online. Null when no daemon is listening on that port.
   */
  connectHypergate(port?: number): Promise<import('@agent-nekko/shared').HypergateInfo | null>;
}

export function createHost(opts: { dataDir: string }): Host {
  setDataDir(opts.dataDir);
  const events = new EventEmitter();
  initOAuth(events);
  initLimits(events);
  const onIndexProgress = (s: IndexStatus) => events.emit('indexProgress', s);
  // Fan terminal output out to renderers over the same event bus.
  setTerminalSender((e) => events.emit('terminalEvent', e));
  // Notify renderers when a session's tracked file changes shift.
  setChangeNotifier((sessionId) => events.emit('changesUpdated', { sessionId }));
  // Automation tasks: fired-task agent events ride the same bus as live chats;
  // task-list changes get their own event. Start the periodic scheduler.
  setTaskSender((e) => events.emit('agentEvent', e));
  setTasksNotifier((tasks) => events.emit('tasksUpdated', tasks));
  startTaskScheduler();
  // Training/goal runs: agent events ride the shared bus; run changes get their
  // own event. Resume any runs that were mid-flight when the host went down.
  setTrainingSender((e) => events.emit('agentEvent', e));
  setTrainingNotifier((runs) => events.emit('trainingUpdated', runs));
  startTrainingScheduler();
  // Workflows: a run's agent steps stream on the shared bus, definition and run
  // changes get their own event. Any run the last shutdown interrupted is
  // written off before the scheduler starts, so it can't look stuck forever.
  setWorkflowSender((e) => events.emit('agentEvent', e));
  setWorkflowsNotifier((snapshot) => events.emit('workflowsUpdated', snapshot));
  reconcileWorkflowRuns();
  startWorkflowScheduler();
  startWorkflowListeners();

  const findProvider = (id: string) => getSettings().providers.find((p) => p.id === id);

  /**
   * Keep one provider entry pointing at the engine.
   *
   * It exists from the first launch rather than from the first successful start,
   * because the Models tab addresses the engine through it: no entry means no id
   * to send a start to, and a start that cannot be addressed is a dead button.
   */
  function ensureEngineProvider(baseUrl: string): void {
    const providers = getSettings().providers;
    const existing = providers.find((p) => p.kind === 'llamacpp');
    if (existing?.baseUrl === baseUrl) return;
    const entry: ProviderConfig = {
      id: existing?.id ?? 'nekko-engine',
      kind: 'llamacpp',
      label: existing?.label ?? 'Agent Nekko engine',
      baseUrl,
      enabled: true,
    };
    saveSettings({ providers: [...providers.filter((p) => p.id !== entry.id), entry] });
  }

  // The engine we run ourselves: llama.cpp behind a router of our own, plus the
  // catalog and library that feed it. Its settings live in the same settings
  // file as everything else, so a missing block reads as the defaults.
  const engine = createEngine({
    dataDir,
    getGpuStats,
    getGpuStatsFresh,
    settings: () => ({ ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine }),
    saveSettings: async (patch) => {
      const next = { ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine, ...patch };
      saveSettings({ engine: next });
      return next;
    },
    onDownloadsChanged: (jobs) => events.emit('downloadsUpdated', jobs),
    // A running engine nobody can select is a running engine for nothing, so its
    // provider entry is kept in step with the address it is actually serving on.
    onServing: (baseUrl) => ensureEngineProvider(baseUrl),
    hfToken: () => getSettings().hfToken || undefined,
    externalBinPath: () => getSettings().engineBinPath || undefined,
  });

  ensureEngineProvider(engineBaseUrl({ ...DEFAULT_ENGINE_SETTINGS, ...getSettings().engine }));
  // Opt-in only, and never fatal: a port taken by something else should leave a
  // line in the engine's log for the Models tab to show, not stop the app from
  // starting.
  if (getSettings().engine?.autoStart) {
    void engine.start().catch(() => {});
  }

  // The runtime control plane. Providers come from settings, hardware from the
  // existing GPU and system probes, so it stays a thin join over what exists.
  const runtimes = createRuntimes({
    findProvider,
    getGpuStats,
    getSystemStats,
    engine,
  });

  const host: Host = {
    events,
    dataDir,
    remote: null as unknown as import('./remote.js').RemoteService, // set right after construction (needs `host`)

    getSettings,
    updateSettings: (patch) => saveSettings(patch),

    listProviders: () => getSettings().providers,
    saveProvider: (p) => {
      const providers = getSettings().providers.filter((x) => x.id !== p.id);
      providers.push(p);
      return saveSettings({ providers }).providers;
    },
    removeProvider: (id) => {
      const removed = findProvider(id);
      if (removed?.tokenKey) clearLimits(removed.tokenKey);
      const providers = getSettings().providers.filter((x) => x.id !== id);
      return saveSettings({ providers }).providers;
    },
    discoverProviders: async () => {
      const discovered = await discoverLocalProviders();
      const merged = [...getSettings().providers];
      for (const d of discovered) if (!merged.some((p) => p.baseUrl === d.baseUrl)) merged.push(d);
      return saveSettings({ providers: merged }).providers;
    },
    probeProviders: () => discoverLocalProviders(),
    testProvider: async (id) => {
      const p = findProvider(id);
      if (!p) return { ok: false, message: 'Not found' };
      try {
        const resolved = await resolveSubscriptionProvider(p);
        return await createProvider(resolved).test();
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    testProviderConfig: async (cfg) => {
      try {
        const resolved = await resolveSubscriptionProvider(cfg);
        return await createProvider(resolved).test();
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },

    listModels: async (providerId) => {
      const p = findProvider(providerId);
      if (!p) return [];
      try {
        const resolved = await resolveSubscriptionProvider(p);
        return await createProvider(resolved).listModels();
      } catch {
        return [];
      }
    },
    pullModel: async (providerId, model) => {
      const p = findProvider(providerId);
      if (!p || p.kind !== 'ollama') return { ok: false, message: 'Pull supported on Ollama only.' };
      try {
        await new OllamaProvider(p).pull(model);
        return { ok: true, message: `Pulled ${model}` };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    loadModel: async (providerId, model) => {
      const p = findProvider(providerId);
      if (p?.kind === 'ollama') return new OllamaProvider(p).setLoaded(model, true);
      // LM Studio has no HTTP load; drive its `lms` CLI for a local instance.
      if (p?.kind === 'lmstudio') return lmsLoad(p.baseUrl, model);
      // Anything else that is a managed runtime loads through the control plane,
      // which is what owns the process the model ends up in.
      if (p && isRuntimeKind(p.kind)) return runtimes.load(providerId, model, {});
      return { ok: true };
    },
    unloadModel: async (providerId, model) => {
      const p = findProvider(providerId);
      if (p?.kind === 'ollama') return new OllamaProvider(p).setLoaded(model, false);
      // LM Studio has no HTTP per-model unload; drive its `lms` CLI instead.
      if (p?.kind === 'lmstudio') return lmsUnload(p.baseUrl, model);
      if (p && isRuntimeKind(p.kind)) return runtimes.unload(providerId, model);
      return { ok: true };
    },
    lmsAvailable: async (providerId) => {
      const p = findProvider(providerId);
      if (p?.kind !== 'lmstudio') return { available: false };
      return lmsProbe(p.baseUrl);
    },
    stopServer: async (providerId) => {
      const p = findProvider(providerId);
      if (!p) return { ok: false, message: 'Provider not found.' };
      if (!isLocalProvider(p.kind)) return { ok: false, message: 'Only local model servers can be stopped from here.' };
      return stopLocalServer(p.baseUrl);
    },
    runtimeStatus: (providerId) => runtimes.status(providerId),
    runtimeStart: (providerId) => runtimes.start(providerId),
    runtimeStop: (providerId, force) => runtimes.stop(providerId, force),
    runtimeLoad: (providerId, modelId, params) => runtimes.load(providerId, modelId, params),
    runtimeFacts: (providerId) => runtimes.facts(providerId),
    runtimePlan: (providerId, modelId, req) => runtimes.plan(providerId, modelId, req),
    runtimeAutoFit: (providerId, modelId, budgetFraction, parallelSlots) =>
      runtimes.autoPlan(providerId, modelId, budgetFraction, parallelSlots),

    engineStatus: () => engine.status(),
    engineInstall: (buildId) => engine.installEngine(buildId),
    engineUninstall: () => engine.uninstallEngine(),
    engineSettingsSave: (patch) => engine.saveSettings(patch),
    engineModels: () => engine.models(),
    engineImportModel: (path) => engine.importModel(path),
    engineDeleteModel: (id) => engine.deleteModel(id),
    engineSaveModelPreset: (id, preset) => engine.saveModelPreset(id, preset),
    engineCatalog: (query) => (query ? engine.catalogSearch(query) : engine.catalogCurated()),
    engineCatalogModel: (id) => engine.catalogModel(id),
    engineDownloadModel: (modelId, quantLabel) => engine.downloadModel(modelId, quantLabel),
    engineDownloads: async () => engine.downloads(),
    engineCancelDownload: async (id) => engine.cancelDownload(id),
    engineDismissDownload: async (id) => engine.dismissDownload(id),
    machineReadiness: async (language) =>
      evaluateReadiness(await gatherMachineFacts(), OFFLINE_STACK_CATALOG, { language }),

    getGpuStats: () => getGpuStats(),
    getSystemStats: () => getSystemStats(),

    listSessions: sessions.listSessions,
    createSession: sessions.createSession,
    getSession: sessions.getSession,
    deleteSession: sessions.deleteSession,
    setSessionWorkspace: sessions.setSessionWorkspace,
    setSessionSupportingWorkspaces: sessions.setSessionSupportingWorkspaces,
    setSessionAttachments: sessions.setSessionAttachments,
    buildSpec,
    buildSpecDoc,
    readSpecDocs,
    setSpecMethodology,
    toggleSpecTask,
    setSpecLinked: sessions.setSpecLinked,
    specPath: specPathForSession,
    setSessionOptions: sessions.setSessionOptions,
    truncateSession: sessions.truncateSession,
    clearSessions: sessions.clearSessions,
    resetSettings,
    wipeAllData: () => {
      sessions.clearSessions('all');
      memory.clearMemory();
      clearUsage();
      clearLimits();
      return resetSettings();
    },
    listTools: () => [...BUILTIN_TOOLS.map((t) => ({ name: t.name, description: t.description })), ...mcpToolList()],
    sendChat: (o) => sendChat(o, (e) => events.emit('agentEvent', e)),
    abortChat,
    queuePrompt: sessions.queuePrompt,
    dequeuePrompt: sessions.dequeuePrompt,
    approveTool: (_sessionId, toolCallId, approved) => resolveApproval(toolCallId, approved),

    listTerminals,
    listShells,
    createTerminal,
    terminalSnapshot,
    updateTerminal,
    writeTerminal,
    resizeTerminal,
    runInTerminal,
    signalTerminal,
    closeTerminal,

    previewContext,
    setContextPrefs,

    listMemory: memory.listMemory,
    saveMemory: (entry) => {
      memory.saveMemory(entry);
      return memory.listMemory(entry.scope, entry.workspaceId);
    },
    deleteMemory: memory.deleteMemory,

    listWorkspaces: () => getSettings().workspaces,
    addWorkspaceByPath: (path) => {
      const folder: WorkspaceFolder = {
        id: `ws_${Date.now().toString(36)}`,
        name: basename(path),
        path,
        addedAt: Date.now(),
      };
      const workspaces = [...getSettings().workspaces, folder];
      saveSettings({ workspaces });
      setTimeout(() => indexWorkspace(folder, onIndexProgress), 50);
      return workspaces;
    },
    removeWorkspace: (id) => {
      const workspaces = getSettings().workspaces.filter((w) => w.id !== id);
      return saveSettings({ workspaces }).workspaces;
    },
    indexWorkspace: (id) => {
      const folder = getSettings().workspaces.find((w) => w.id === id);
      if (!folder) throw new Error('Workspace not found');
      return indexWorkspace(folder, onIndexProgress);
    },
    getIndexStatus,
    searchWorkspace: (id, query) => {
      const folder = getSettings().workspaces.find((w) => w.id === id);
      return folder ? searchWorkspace(folder, query) : [];
    },
    listFiles: listIndexedFiles,
    readFile,
    writeFile,
    listDir,
    listChanges,
    acceptChange,
    acceptAllChanges,
    listSessionPrs,
    getPrDiff,
    prAction,
    listComments,
    addComment,
    resolveComment,
    getDesignBoard,
    addDesignPage,
    updateDesignPage,
    removeDesignPage,
    addDesignNote,
    resolveDesignNote,
    generateDesign,
    listInstalledSkills,
    skillTargets,
    installSkill,
    uninstallSkill,
    vaizerCatalog: (refresh?: boolean) => getVaizerCatalog(refresh),
    vaizerSkillMd: (slug: string) => getVaizerSkillMd(slug),

    listTasks,
    createTask,
    updateTask,
    deleteTask,
    runTaskNow,

    listTrainingRuns,
    createTrainingRun,
    updateTrainingRun,
    deleteTrainingRun,
    startTrainingRun,
    pauseTrainingRun,
    stopTrainingRun,
    addTrainingHint,

    listWorkflows: workflowsSnapshot,
    createWorkflow,
    updateWorkflow,
    deleteWorkflow: (id: string) => {
      deleteWorkflow(id);
      return workflowsSnapshot();
    },
    duplicateWorkflow,
    runWorkflow: (id: string) => runWorkflow(id),
    cancelWorkflowRun,
    listWorkflowRuns,
    dispatchWorkflowEvent,
    dispatchWebhook,

    listConnectors: () => getSettings().connectors,
    connectConnector: (kind, token, settings) => {
      const connectors = getSettings().connectors.filter((c) => c.kind !== kind);
      connectors.push({ kind, connected: true, token, settings, connectedAt: Date.now() });
      return saveSettings({ connectors }).connectors;
    },
    disconnectConnector: (kind) => {
      const connectors = getSettings().connectors.filter((c) => c.kind !== kind);
      return saveSettings({ connectors }).connectors;
    },
    fetchConnector: async (kind, query) => {
      const cfg = getSettings().connectors.find((c) => c.kind === kind);
      // Some connectors work without a token (e.g. a Teams incoming webhook
      // lives in settings), so connected-not-token is the gate; a connector
      // that genuinely needs a token fails on its own fetch.
      if (!cfg?.connected) throw new Error('Connector not connected');
      return getConnector(kind).fetch(cfg.token ?? '', query, cfg.settings);
    },

    detectAgentTools: () => detectAgentTools(),
    installSubagent: (tool) => installSubagent(tool),
    subagentSnippet: (tool) => subagentSnippet(tool),

    classifyCommand: (command) => classifyCommand(command, getSettings().guardrails),
    usageSummary,
    getLimits: (tokenKey) => getLimits(tokenKey),

    enableRemote: (relayUrl) => host.remote.enable(relayUrl),
    disableRemote: () => host.remote.disable(),
    remoteStatus: () => host.remote.status(),
    remotePairing: () => host.remote.pairing(),
    startRemotePairing: () => host.remote.pair(),
    listRemoteDevices: () => host.remote.devices(),
    revokeRemoteDevice: (deviceId) => host.remote.revoke(deviceId),
    renameRemoteDevice: (deviceId, name) => host.remote.rename(deviceId, name),
    rotateRemoteSecret: () => host.remote.rotate(),

    beginOAuth,
    finishOAuth,
    cancelOAuth: async (sessionId) => { cancelOAuth(sessionId); },
    oauthStatus: async (providerConfigId) => {
      const provider = findProvider(providerConfigId);
      if (!provider?.tokenKey) {
        return {
          tokenKey: providerConfigId,
          connected: false,
          state: 'missing',
          message: provider ? 'Provider has no token key.' : 'Provider not found.',
        };
      }
      return getOAuthStatus(provider.tokenKey);
    },
    oauthSignOut: async (providerConfigId) => {
      const provider = findProvider(providerConfigId);
      if (provider?.tokenKey) {
        signOutOAuth(provider.tokenKey);
        clearLimits(provider.tokenKey);
      }
    },
    importCliAuth: async () => importCliAuth(),

    appInfo: () => ({ version: brandEnv('VERSION') ?? '0.0.0', platform: process.platform, edition: 'web' }),
    mcpStatus: async () => {
      const configs = getSettings().mcpServers ?? [];
      await syncMcp(configs);
      return mcpStatus(configs);
    },
    detectHypergate: (port) => detectHypergate(port),
    connectHypergate: async (port) => {
      const info = await resolveHypergate(port);
      if (!info) return null;
      // Save first, then sync: `syncMcp` reads the list it is given, and a
      // connect that brought tools online without persisting the entry would
      // come back disconnected on the next launch.
      const next = saveSettings({ mcpServers: withHypergate(getSettings().mcpServers ?? [], info) });
      await syncMcp(next.mcpServers ?? []);
      return info;
    },
  };
  // Remote access needs the finished host (it dispatches into it); reconnect if
  // remote access was left enabled when the host last shut down.
  host.remote = createRemoteService(host);
  host.remote.startIfEnabled();
  return host;
}
