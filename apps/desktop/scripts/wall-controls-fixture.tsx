import { assembleContext } from '@fixture/context';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { putCachedSession, __resetSessionCache } from '../src/renderer/sessionCache';
import { TitleBar } from '../src/renderer/components/TitleBar';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { CommandCenterView } from '../src/renderer/views/CommandCenterView';
import { WorkspacesView } from '../src/renderer/views/WorkspacesView';
import { DEFAULT_WALL_STATE } from '../src/renderer/commandWall';
import { summarizeSession } from '@agent-nekko/shared';
import '../src/renderer/styles.css';

// Synthetic records only. This fixture never connects to a host or daemon.
const provider = { name: 'Fixture provider', id: 'fixture', kind: 'openai', enabled: true, label: 'Fixture provider' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture model', contextWindow: 128000 }, { id:'fixture-fast',providerId:'fixture',name:'Fast fixture',contextWindow:32000 }];
const makeSession = (id: string) => ({ id, title: id === 'existing' ? 'Existing conversation' : `Synthetic ${id}`, createdAt: Date.now(), updatedAt: Date.now(), providerId: 'fixture', modelId: 'fixture-model', mode: 'guardrails', chatType: 'multimodal', messages: [{ id: 'synthetic-user', role: 'user', content: 'Please verify the chat actions.', createdAt: 1 }, { id: 'synthetic-reply', role: 'assistant', content: 'The verification reply is complete.', createdAt: 2 }], attachments: [], queuedPrompts: [] });
let pending: any = {};
const listeners = new Set<(e: any) => void>();
let records: any[] = [];
let terminals: any[] = [];
let serial = 0;
const calls: any[] = [];
const failures = { create: false, options: false, cleanup: false };
const contextBundle = () => assembleContext({ attached: [{path:'synthetic.txt',content:'context '.repeat(100)}], guidelines:[{path:'AGENTS.md',content:'Preserve existing work.'}], memory:[], connectorSnippets:[], indexSnippets:[], history:records[0]?.messages ?? [], systemText:'Synthetic system instructions', contextWindow:128000 });
const bridge: any = {
  getAppInfo: async () => ({ version: '0.8.0', edition: 'desktop', packaged: false, platform: 'win32' }),
  sendChat: async (options: any) => { calls.push({method:'send',options}); },
  createSession: async (workspaceId: string) => { calls.push({ method: 'create', workspaceId }); if (failures.create) throw Error('Synthetic creation failure'); const s = { ...makeSession(`new-${++serial}`), workspaceId }; records.push(s); return s; },
  setSessionOptions: async (id: string, options: any) => { calls.push({ method: 'options', id, options }); if (failures.options) throw Error('Synthetic options failure'); const s = records.find(s => s.id === id); Object.assign(s, options); sessionStorage.setItem('fixture-record', JSON.stringify(s)); return {...s}; },
  deleteSession: async (id: string) => { calls.push({ method: 'cleanup', id }); if (failures.cleanup) throw Error('Synthetic cleanup failure'); records = records.filter(s => s.id !== id); },
  createTerminal: async (options: any) => { calls.push({ method: 'terminal', options }); const t = { id: `terminal-${++serial}`, title: 'Synthetic terminal', cwd: '/synthetic', running: false }; terminals.push(t); return t; },
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  getSession: async (id: string) => records.find(s => s.id === id), listModels: async () => models,
  getUsageSummary: async () => null, pendingInput: async () => pending, onAgentEvent: (fn: any) => {listeners.add(fn);return () => listeners.delete(fn)}, answerQuestion: async (id: string, callId: string, answers: any) => {calls.push({method:'answer',id,callId,answers});pending={};listeners.forEach(fn=>fn({type:'question_resolved',sessionId:id,callId}));}, runningSessions: async () => [],
  listTasks: async () => [], listShells: async () => [], listChanges: async () => [], listFiles: async () => [],
  previewContext: async () => contextBundle(), getGitStatus: async () => ({ repo: true, branch: 'synthetic-branch', worktree: { name: 'synthetic-worktree', path: '/synthetic/worktree' } }),
  getLimits: async () => null, listTools: async () => [], getMcpStatus: async () => [], listSkills: async () => [],
  terminalRead: async () => '', readTerminal: async () => '', updateSettings: async () => null,
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) { if (key in target) return target[key]; if (key.startsWith('on')) return () => () => {}; return () => Promise.resolve(null); } }) });
function Fixture() {
  const [epoch, setEpoch] = useState(0);
  const [route, setRoute] = useState('command');
  const reset = () => {
    records = [JSON.parse(sessionStorage.getItem('fixture-record') || 'null') || makeSession('existing'), ...(new URLSearchParams(location.search).has('multi') ? [makeSession('second'), makeSession('third')] : [])]; __resetSessionCache(); pending = {}; terminals = []; serial = 0; calls.length = 0;
    Object.assign(failures, { create: false, options: false, cleanup: false });
    localStorage.clear();
    useStore.setState({ view: 'command', providers: [provider], models, activeProviderId: 'fixture', sessions: records.map(summarizeSession), terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', settings: { providers: [provider], workspaceFolders: [], workspaces: [], theme: 'light', experimental: {}, agent: {}, ui: {}, commandWall: { ...DEFAULT_WALL_STATE, root: records.length > 1 ? { id: 'synthetic-split', dir: 'row', children: records.map((s,i) => ({id:`synthetic-pane-${i}`,kind:'chat',refId:s.id})), sizes: records.map(() => 1/records.length) } : { id: 'synthetic-pane', kind: 'chat', refId: 'existing' }, autoAdd: false, watermark: Date.now(), dock: { ...DEFAULT_WALL_STATE.dock, show: false } } }, activeSkillBySession: {}, prsBySession: {}, installedSkillDefs: [], contextPanelOpen: false, planRailOpen: false } as any);
    setRoute('command'); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, pointerTarget: (kind: string, scroll: boolean) => {
    const selectors: Record<string, string> = { grid: '[data-wall-composer] button[title="Run freely; ask/deny per guardrail rules."]', mode: 'button[title="Run freely; ask/deny per guardrail rules."]', ask: 'button[title="Confirm every file write and command."]', item: '[role=menuitemradio]' };
    const selector=selectors[kind]; if(!selector)throw Error('Unknown pointer target');
    const el=document.querySelector(selector);if(!el)throw Error('Missing '+selector);
    if(scroll)el.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};
  }, providerKind: (kind: string) => { const providers=[{...provider,kind}]; useStore.setState({providers,settings:{...useStore.getState().settings,providers}} as any); }, blank: () => { sessionStorage.setItem('fixture-record', JSON.stringify({...makeSession('existing'), providerId: undefined, modelId: undefined, messages: []})); reset(); }, noProgress: () => { const s=makeSession('existing'); s.messages=s.messages.slice(0,1); sessionStorage.setItem('fixture-record',JSON.stringify(s)); reset(); }, contextBundle, fail: () => listeners.forEach(fn=>fn({type:'error',sessionId:'existing',message:'Synthetic request failed'})), ask: () => { const request = {callId:'ask-fixture',askedAt:Date.now(),questions:[{id:'choice',header:'Choice',question:'Which verification path?',options:[{label:'Focused tests'},{label:'Full suite'}]}]}; pending={existing:{question:request}}; listeners.forEach(fn=>fn({type:'question',sessionId:'existing',request})); }, calls, failures, dock: (side: 'top' | 'bottom') => { const settings=useStore.getState().settings!;useStore.setState({settings:{...settings,commandWall:{...settings.commandWall!,composer:{...DEFAULT_WALL_STATE.composer,side}}}});setEpoch(e=>e+1); }, route: (next: string) => { useStore.setState({ view: next === 'command' ? 'command' : 'chat' }); setRoute(next); }, state: () => useStore.getState(), records: () => records } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }} key={epoch}><TitleBar /><div style={{ flex: 1, minHeight: 0 }}>{route === 'command' ? <CommandCenterView /> : <WorkspacesView />}</div></main>;
}
createRoot(document.getElementById('root')!).render(<UpdateProvider><Fixture /></UpdateProvider>);
