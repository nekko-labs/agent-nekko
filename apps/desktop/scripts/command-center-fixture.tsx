import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { WorkspacesView } from '../src/renderer/views/WorkspacesView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@agent-nekko/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const makeSession = (id: string) => ({ id, title: id === 'existing' ? 'Existing conversation' : `Synthetic ${id}`, createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', messages: [], attachments: [], queuedPrompts: [] });
let records: any[] = [];
let terminals: any[] = [];
let serial = 0;
const calls: any[] = [];
const failures = { create: false, options: false, cleanup: false };
const bridge: any = {
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); if (failures.create) throw Error('Synthetic creation failure'); const s = { ...makeSession(`new-${++serial}`), workspaceId }; records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); if (failures.options) throw Error('Synthetic options failure'); const s = records.find(s => s.id === id); Object.assign(s, options); return s; },
  deleteSession: async (id: string) => { calls.push({ method: 'cleanup', id }); if (failures.cleanup) throw Error('Synthetic cleanup failure'); records = records.filter(s => s.id !== id); },
  createTerminal: async (options: any) => { calls.push({ method: 'terminal', options }); const t = { id: `terminal-${++serial}`, title: 'Synthetic terminal', cwd: '/synthetic', running: false }; terminals.push(t); return t; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => ({}), runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getLimits: async () => null, listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  terminalRead: async () => '', readTerminal: async () => '', updateSettings: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [route, setRoute] = useState('command');
  const reset = () => {
    records = [makeSession('existing')]; terminals = []; serial = 0; calls.length = 0;
    Object.assign(failures, { create: false, options: false, cleanup: false });
    localStorage.clear();
    useStore.setState({ providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root: { id: 'synthetic-pane', kind: 'chat', refId: 'existing' }, autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    records.forEach(putCachedSession); setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, calls, failures, route: setRoute, state: () => useStore.getState(), records: () => records } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh' }} key={epoch}>{route === 'command' ? <CommandCenterView /> : <WorkspacesView />}</main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
