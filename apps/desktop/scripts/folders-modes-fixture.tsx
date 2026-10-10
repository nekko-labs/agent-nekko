import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../src/renderer/store';
import { FolderPicker } from '../src/renderer/components/FolderPicker';
import { ChatControls } from '../src/renderer/components/ChatControls';
import '../src/renderer/styles.css';

// All APIs operate on synthetic memory only, including folder and container APIs.
let record: any;
let settings: any;
const calls: any[] = [];
const failures = { options: false, remove: false, configure: true, folder: false };
const copy = (x: any) => JSON.parse(JSON.stringify(x));
const bridge = {
  listTools: async () => [],
  getSettings: async () => copy(settings),
  listSessionSummaries: async () => [copy(record)],
  getSession: async () => copy(record),
  setSessionWorkspace: async (_id: string, workspaceId: string) => { if (failures.folder) throw Error('Synthetic folder failure'); record.workspaceId = workspaceId; },
  setSessionSupportingWorkspaces: async (_id: string, ids: string[]) => { record.supportingWorkspaceIds = ids; return copy(record); },
  setSessionOptions: async (_id: string, patch: any) => { calls.push({ api: 'options', patch }); if (failures.options) throw Error('Synthetic options failure'); Object.assign(record, patch); return copy(record); },
  updateSettings: async (patch: any) => { Object.assign(settings, patch); return copy(settings); },
  removeWorkspace: async (id: string) => { if (failures.remove) throw Error('Synthetic removal failure'); settings.workspaces = settings.workspaces.filter((w: any) => w.id !== id); if (record.workspaceId === id) record.workspaceId = undefined; record.supportingWorkspaceIds = record.supportingWorkspaceIds.filter((v: string) => v !== id); },
  pickFolder: async () => '/synthetic/added',
  addWorkspaceByPath: async (path: string) => { settings.workspaces.push({ id: 'added', name: 'Added folder', path }); return copy(settings.workspaces); },
  cleanupSandbox: async (id: string, identity: string) => { calls.push({ api: 'cleanup', id, identity }); },
  configureSandbox: async (_id: string, image: string) => { calls.push({ api: 'configure', image }); return failures.configure ? { phase: 'error', error: 'Synthetic local image unavailable' } : { phase: 'ready' }; },
};
Object.assign(window, { nekko: bridge });
function Fixture() {
  const [session, setSession] = useState<any>(null);
  const [epoch, setEpoch] = useState(0);
  const reset = () => {
    record = { id: 'fixture', title: 'Synthetic chat', workspaceId: 'alpha', supportingWorkspaceIds: [], mode: 'guardrails', executionMode: 'worktree', gitIsolation: true, messages: [], createdAt: 1, updatedAt: 1 };
    settings = { workspaces: [{ id: 'alpha', name: 'Alpha project', path: '/synthetic/alpha' }, { id: 'beta', name: 'Beta reference', path: '/synthetic/beta' }], defaultChatMode: 'guardrails', mcpServers: [], gitManagement: { mode: 'worktree' } };
    calls.length = 0; Object.assign(failures, { options: false, remove: false, configure: true, folder: false }); localStorage.clear();
    useStore.setState({ settings: copy(settings), sessions: [copy(record)], activeProjectId: 'alpha', toasts: [] } as any);
    setSession(copy(record)); setEpoch(e => e + 1);
  };
  Object.assign(window, { integration: { reset, configureRecord: () => { record.executionMode = 'sandbox'; record.sandbox = { identity: 'synthetic-owned', image: 'local@sha256:' + 'a'.repeat(64), sourceWorkspaceIds: ['alpha'], configuredAt: 1 }; setSession(copy(record)); }, failures, calls, record: () => copy(record), state: () => useStore.getState(), persisted: () => JSON.parse(localStorage.getItem('nekko.lastPrimaryFolder') ?? 'null') } });
  React.useEffect(reset, []);
  return <main style={{ height: '100vh', padding: 16, display: 'flex', alignItems: 'flex-end', background: 'var(--surface)' }}><section className="card w-full p-4"><h1 className="mb-3 text-sm">Synthetic folder and execution controls</h1><div key={epoch} className="flex flex-wrap items-center gap-2"><FolderPicker sessionId="fixture" session={session} onChange={setSession} /><ChatControls session={session} isCloudModel={false} onChange={setSession} only="mode" /></div></section></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
