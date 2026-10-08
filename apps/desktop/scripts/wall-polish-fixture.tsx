import './wall-polish-chrome';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession } from '../src/renderer/sessionCache';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { TitleBar } from '../src/renderer/components/TitleBar';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { ReplyStatus } from '../src/renderer/components/agent-console/ReplyStatus';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@agent-nekko/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const provider = { id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider', auth: 'subscription', tokenKey: 'fixture' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }];
const at = Date.now();
const makeSession = (id: string, title: string, workspaceId?: string) => ({
  id, title, createdAt: at, updatedAt: at, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', chatType: 'multimodal', workspaceId,
  messages: [
    { id: id + '-u', role: 'user', content: 'Summarise the synthetic fixture.', createdAt: at - 60_000 },
    { id: id + '-a', role: 'assistant', content: 'The synthetic fixture renders two agent windows and one chat that is not on the wall.', createdAt: at - 30_000 },
  ],
  attachments: [], queuedPrompts: [],
});
let records: any[] = [];
const calls: any[] = [];
const bridge: any = {
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); const s = makeSession(`new-${records.length}`, 'New chat', workspaceId); records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); const s = records.find(s => s.id === id); Object.assign(s, options); return { ...s }; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => [],
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => ({}), runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => ({ items: [], totalTokens: 0, budget: 128000 }), getGitStatus: async () => ({ repo: false }),
  getAppInfo: async () => ({ version: '0.0.0-fixture', platform: 'win32' }), getUpdateInfo: async () => null,
  listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  updateSettings: async (patch: any) => ({ ...useStore.getState().settings, ...patch }),
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });

function StatusGallery() {
  const now = Date.now();
  const base = { streaming: false, status: '', elapsed: 0, tps: 0, out: 1300, last: { out: 1300, tps: 0, secs: 61 }, now };
  return <div style={{ padding: 24, width: 520 }} className="space-y-6 bg-paper">
    <ReplyStatus {...base} nextWakeAt={now + 13 * 60_000} />
    <ReplyStatus {...base} done="Done" />
  </div>;
}

function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [route, setRoute] = useState('command');
  const reset = () => {
    records = [makeSession('alpha', 'Fix wall and composer styling'), makeSession('beta', 'Analyze post-merge perf trace'), makeSession('outside', 'Chat not on the wall')];
    calls.length = 0;
    localStorage.clear();
    const root = { id: 'split', dir: 'row', sizes: [0.5, 0.5], children: [{ id: 'pane-alpha', kind: 'chat', refId: 'alpha' }, { id: 'pane-beta', kind: 'chat', refId: 'beta' }] };
    useStore.setState({ view: 'command', providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: null, settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'dark', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root, hero: 'alpha', autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    records.forEach(putCachedSession); setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, calls, route: setRoute, state: () => useStore.getState(), records: () => records } });
  React.useEffect(reset, []);
  return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} className="bg-paper" key={epoch}>
    <UpdateProvider><TitleBar /></UpdateProvider>
    <main style={{ flex: 1, minHeight: 0 }}>{route === 'command' ? <CommandCenterView /> : <StatusGallery />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
