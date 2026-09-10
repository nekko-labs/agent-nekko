import { IpcChannels } from '@agent-nekko/shared';
import type { Host } from './host.js';

/**
 * Maps an IPC channel + positional args to the matching Host method. Shared by
 * every transport (Electron IPC, the web server's HTTP routes) so request
 * routing lives in exactly one place. Returns the method's result.
 *
 * Note: `workspaceAdd` (the native folder picker) has no headless equivalent, so
 * transports that can't show a dialog (web) should call `workspaceAddByPath`
 * instead; here it degrades to listing current workspaces.
 */
export function createDispatcher(host: Host): (channel: string, args: any[]) => unknown {
  const C = IpcChannels;
  const table: Record<string, (a: any[]) => unknown> = {
    [C.settingsGet]: () => host.getSettings(),
    [C.settingsUpdate]: ([patch]) => host.updateSettings(patch),

    [C.providersList]: () => host.listProviders(),
    [C.providersSave]: ([p]) => host.saveProvider(p),
    [C.providersRemove]: ([id]) => host.removeProvider(id),
    [C.providersDiscover]: () => host.discoverProviders(),
    [C.providersProbe]: () => host.probeProviders(),
    [C.providersTest]: ([id]) => host.testProvider(id),
    [C.providersTestConfig]: ([cfg]) => host.testProviderConfig(cfg),

    [C.modelsList]: ([id]) => host.listModels(id),
    [C.modelPull]: ([id, m]) => host.pullModel(id, m),
    [C.modelLoad]: ([id, m]) => host.loadModel(id, m),
    [C.modelUnload]: ([id, m]) => host.unloadModel(id, m),
    [C.lmsProbe]: ([id]) => host.lmsAvailable(id),
    [C.serverStop]: ([id]) => host.stopServer(id),
    [C.runtimeStatus]: ([id]) => host.runtimeStatus(id),
    [C.runtimeStart]: ([id]) => host.runtimeStart(id),
    [C.runtimeStop]: ([id, force]) => host.runtimeStop(id, force),
    [C.runtimeLoad]: ([id, model, params]) => host.runtimeLoad(id, model, params),
    [C.runtimeFacts]: ([id]) => host.runtimeFacts(id),
    [C.runtimePlan]: ([id, model, req]) => host.runtimePlan(id, model, req),
    [C.gpuStats]: () => host.getGpuStats(),
    [C.systemStats]: () => host.getSystemStats(),

    [C.sessionsList]: () => host.listSessions(),
    [C.sessionCreate]: ([wid]) => host.createSession(wid),
    [C.sessionGet]: ([id]) => host.getSession(id),
    [C.sessionDelete]: ([id]) => host.deleteSession(id),
    [C.sessionSetWorkspace]: ([id, wid]) => host.setSessionWorkspace(id, wid),
    [C.sessionSetSupportingWorkspaces]: ([id, wids]) => host.setSessionSupportingWorkspaces(id, wids),
    [C.chatSend]: ([opts]) => host.sendChat(opts),
    [C.chatAbort]: ([id]) => host.abortChat(id),
    [C.chatQueue]: ([id, text]) => host.queuePrompt(id, text),
    [C.chatDequeue]: ([id, idx]) => host.dequeuePrompt(id, idx),
    [C.toolApprove]: ([sid, tid, ok]) => host.approveTool(sid, tid, ok),

    [C.terminalsList]: () => host.listTerminals(),
    [C.terminalShells]: () => host.listShells(),
    [C.terminalCreate]: ([opts]) => host.createTerminal(opts),
    [C.terminalSnapshot]: ([id]) => host.terminalSnapshot(id),
    [C.terminalUpdate]: ([id, patch]) => host.updateTerminal(id, patch),
    [C.terminalWrite]: ([id, data]) => host.writeTerminal(id, data),
    [C.terminalResize]: ([id, cols, rows]) => host.resizeTerminal(id, cols, rows),
    [C.terminalRun]: ([id, cmd]) => host.runInTerminal(id, cmd),
    [C.terminalSignal]: ([id, sig]) => host.signalTerminal(id, sig),
    [C.terminalClose]: ([id]) => host.closeTerminal(id),

    [C.contextPreview]: ([sid, paths]) => host.previewContext(sid, paths),
    [C.contextToggle]: ([sid]) => host.previewContext(sid, []),
    [C.contextSetPrefs]: ([sid, prefs]) => host.setContextPrefs(sid, prefs),
    [C.sessionSetAttachments]: ([sid, paths]) => host.setSessionAttachments(sid, paths),
    [C.specBuild]: ([sid]) => host.buildSpec(sid),
    [C.specBuildDoc]: ([sid, docId, wid]) => host.buildSpecDoc(sid, docId, wid),
    [C.specReadDocs]: ([sid, wid]) => host.readSpecDocs(sid, wid),
    [C.specSetMethodology]: ([sid, mid]) => host.setSpecMethodology(sid, mid),
    [C.specToggleTask]: ([sid, line, wid]) => host.toggleSpecTask(sid, line, wid),
    [C.specSetLinked]: ([sid, linked]) => host.setSpecLinked(sid, linked),
    [C.specPath]: ([sid]) => host.specPath(sid),
    [C.sessionSetOptions]: ([sid, patch]) => host.setSessionOptions(sid, patch),
    [C.sessionTruncate]: ([sid, mid]) => host.truncateSession(sid, mid),
    [C.sessionsClear]: ([scope]) => host.clearSessions(scope),
    [C.settingsReset]: () => host.resetSettings(),
    [C.dataWipe]: () => host.wipeAllData(),
    [C.toolsList]: () => host.listTools(),

    [C.memoryList]: ([scope, wid]) => host.listMemory(scope, wid),
    [C.memorySave]: ([entry]) => host.saveMemory(entry),
    [C.memoryDelete]: ([id]) => host.deleteMemory(id),

    [C.workspaceList]: () => host.listWorkspaces(),
    [C.workspaceAdd]: () => host.listWorkspaces(), // no headless folder picker
    [C.workspaceAddByPath]: ([p]) => host.addWorkspaceByPath(p),
    [C.workspaceRemove]: ([id]) => host.removeWorkspace(id),
    [C.workspaceIndex]: ([id]) => host.indexWorkspace(id),
    [C.workspaceIndexStatus]: ([id]) => host.getIndexStatus(id),
    [C.workspaceSearch]: ([id, q]) => host.searchWorkspace(id, q),
    [C.workspaceFiles]: ([id]) => host.listFiles(id),

    [C.fileRead]: ([p]) => host.readFile(p),
    [C.fileWrite]: ([p, content]) => host.writeFile(p, content),
    [C.dirList]: ([p]) => host.listDir(p),

    [C.changesList]: ([sid]) => host.listChanges(sid),
    [C.changeAccept]: ([sid, p]) => host.acceptChange(sid, p),
    [C.changeAcceptAll]: ([sid]) => host.acceptAllChanges(sid),

    [C.prSessionList]: ([sid]) => host.listSessionPrs(sid),
    [C.prDiff]: ([url]) => host.getPrDiff(url),
    [C.prAction]: ([url, action]) => host.prAction(url, action),

    [C.commentsList]: ([p]) => host.listComments(p),
    [C.commentAdd]: ([p, line, lineText, comment]) => host.addComment(p, line, lineText, comment),
    [C.commentResolve]: ([p, id]) => host.resolveComment(p, id),

    [C.designGet]: ([wid]) => host.getDesignBoard(wid),
    [C.designAddPage]: ([wid, label, url]) => host.addDesignPage(wid, label, url),
    [C.designUpdatePage]: ([wid, pid, patch]) => host.updateDesignPage(wid, pid, patch),
    [C.designRemovePage]: ([wid, pid]) => host.removeDesignPage(wid, pid),
    [C.designAddNote]: ([wid, pid, text]) => host.addDesignNote(wid, pid, text),
    [C.designResolveNote]: ([wid, pid, nid]) => host.resolveDesignNote(wid, pid, nid),
    [C.designGenerate]: ([wid, input]) => host.generateDesign(wid, input),

    [C.skillsInstalled]: () => host.listInstalledSkills(),
    [C.skillsTargets]: () => host.skillTargets(),
    [C.skillInstall]: ([id, target, payload]) => host.installSkill(id, target, payload),
    [C.skillUninstall]: ([id, target]) => host.uninstallSkill(id, target),
    [C.vaizerCatalog]: ([refresh]) => host.vaizerCatalog(refresh),
    [C.vaizerSkillMd]: ([slug]) => host.vaizerSkillMd(slug),

    [C.tasksList]: () => host.listTasks(),
    [C.taskCreate]: ([task]) => host.createTask(task),
    [C.taskUpdate]: ([id, patch]) => host.updateTask(id, patch),
    [C.taskDelete]: ([id]) => host.deleteTask(id),
    [C.taskRunNow]: ([id]) => host.runTaskNow(id),

    [C.trainingList]: () => host.listTrainingRuns(),
    [C.trainingCreate]: ([input]) => host.createTrainingRun(input),
    [C.trainingUpdate]: ([id, patch]) => host.updateTrainingRun(id, patch),
    [C.trainingDelete]: ([id]) => host.deleteTrainingRun(id),
    [C.trainingStart]: ([id]) => host.startTrainingRun(id),
    [C.trainingPause]: ([id]) => host.pauseTrainingRun(id),
    [C.trainingStop]: ([id]) => host.stopTrainingRun(id),
    [C.trainingHint]: ([id, text]) => host.addTrainingHint(id, text),

    [C.workflowsList]: () => host.listWorkflows(),
    [C.workflowCreate]: ([input]) => host.createWorkflow(input),
    [C.workflowUpdate]: ([id, patch]) => host.updateWorkflow(id, patch),
    [C.workflowDelete]: ([id]) => host.deleteWorkflow(id),
    [C.workflowDuplicate]: ([id]) => host.duplicateWorkflow(id),
    [C.workflowRun]: ([id]) => host.runWorkflow(id),
    [C.workflowCancel]: ([runId]) => host.cancelWorkflowRun(runId),
    [C.workflowRuns]: ([wid]) => host.listWorkflowRuns(wid),
    [C.workflowEvent]: ([event]) => host.dispatchWorkflowEvent(event),

    [C.connectorsList]: () => host.listConnectors(),
    [C.connectorConnect]: ([kind, token, settings]) => host.connectConnector(kind, token, settings),
    [C.connectorDisconnect]: ([kind]) => host.disconnectConnector(kind),
    [C.connectorFetch]: ([kind, query]) => host.fetchConnector(kind, query),

    [C.integrationsDetect]: () => host.detectAgentTools(),
    [C.integrationsInstall]: ([tool]) => host.installSubagent(tool),
    [C.integrationsSnippet]: ([tool]) => host.subagentSnippet(tool),

    [C.guardrailsClassify]: ([cmd]) => host.classifyCommand(cmd),
    [C.usageSummary]: () => host.usageSummary(),
    [C.limitsGet]: ([tokenKey]) => host.getLimits(tokenKey),

    [C.oauthBegin]: ([provider]) => host.beginOAuth(provider),
    [C.oauthFinish]: ([sessionId, pasted]) => host.finishOAuth(sessionId, pasted),
    [C.oauthCancel]: ([sessionId]) => host.cancelOAuth(sessionId),
    [C.oauthStatus]: ([providerConfigId]) => host.oauthStatus(providerConfigId),
    [C.oauthSignOut]: ([providerConfigId]) => host.oauthSignOut(providerConfigId),
    [C.providersImportCliAuth]: () => host.importCliAuth(),

    [C.remoteEnable]: ([relayUrl]) => host.enableRemote(relayUrl),
    [C.remoteDisable]: () => host.disableRemote(),
    [C.remoteStatus]: () => host.remoteStatus(),
    [C.remotePairing]: () => host.remotePairing(),
    [C.remotePair]: () => host.startRemotePairing(),
    [C.remoteDevices]: () => host.listRemoteDevices(),
    [C.remoteRevoke]: ([deviceId]) => host.revokeRemoteDevice(deviceId),
    [C.remoteRename]: ([deviceId, name]) => host.renameRemoteDevice(deviceId, name),
    [C.remoteRotate]: () => host.rotateRemoteSecret(),

    [C.appInfo]: () => host.appInfo(),
    [C.mcpStatus]: () => host.mcpStatus(),
    [C.mcpHypergate]: ([port]) => host.detectHypergate(port),
    [C.mcpHypergateConnect]: ([port]) => host.connectHypergate(port),
  };

  return (channel, args) => {
    const fn = table[channel];
    if (!fn) throw new Error(`Unknown channel: ${channel}`);
    return fn(args ?? []);
  };
}
