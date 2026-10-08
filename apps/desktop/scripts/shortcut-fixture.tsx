import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/renderer/App';
import { UpdateProvider } from '../src/renderer/components/UpdateBanner';
import { useStore } from '../src/renderer/store';
import { summarizeSession } from '@agent-nekko/shared';

// Real App and store actions; only the host boundary is synthetic.
const provider = { id: 'fixture', kind: 'ollama', enabled: true, baseUrl: 'http://invalid.local' };
const models = [{ id: 'fixture-model', providerId: 'fixture', name: 'Fixture', contextWindow: 32000 }];
const settings = { providers: [provider], defaultProviderId: 'fixture', defaultModelId: 'fixture-model', workspaces: [], workspaceFolders: [], onboarding: { completedAt: 1 }, experimental: {}, developer: { chat: true }, agent: {}, ui: {} };
const records: any[] = [];
const terminals: any[] = [];
const calls: any[] = [];
const bridge: Record<string, any> = {
  getSettings: async () => settings, listProviders: async () => [provider], listModels: async () => models,
  listSessionSummaries: async () => records.map(summarizeSession), listTerminals: async () => terminals,
  createSession: async (workspaceId: string) => {
    const s = { id: `agent-${records.length}`, title: 'Synthetic agent', createdAt: 1, updatedAt: 1, providerId: 'fixture', modelId: 'fixture-model', mode: 'agent', messages: [], attachments: [], queuedPrompts: [] };
    records.push(s); calls.push({ method: 'createSession', workspaceId }); return s;
  },
  createTerminal: async (options: any) => { const t = { id: `terminal-${terminals.length}`, title: 'Synthetic terminal', ...options }; terminals.push(t); calls.push({ method: 'createTerminal', options }); return t; },
  getSession: async (id: string) => records.find(s => s.id === id),
  updateSettings: async (patch: any) => ({ ...settings, ...patch }),
  getAppInfo: async () => ({ version: 'shortcut-fixture', platform: 'win32' }),
  pendingInput: async () => ({}), runningSessions: async () => [],
};
Object.assign(window, { nekko: new Proxy(bridge, { get(target, key: string) {
  if (key in target) return target[key];
  if (key.startsWith('on')) return () => () => {};
  if (key.startsWith('list')) return async () => [];
  return async () => null;
} }) });
useStore.setState({ settings: settings as any, settingsLoaded: true, providers: [provider] as any, models, activeProviderId: 'fixture', activeModelId: 'fixture-model', view: 'skills' });
Object.assign(window, { shortcutTest: {
  reset(onboardingOpen = false) {
    records.length = 0; terminals.length = 0; calls.length = 0;
    useStore.setState({ view: 'skills', sessions: [], terminals: [], workspaces: [], activeWorkspaceId: null, activeSessionId: null, activeProjectId: 'synthetic-project', onboardingOpen });
  },
  dispatch(init: KeyboardEventInit) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    const dispatched = window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatched };
  },
  snapshot() {
    const s = useStore.getState();
    return { calls: [...calls], view: s.view, sessions: s.sessions, terminals: s.terminals, workspaces: s.workspaces, activeSessionId: s.activeSessionId, activeWorkspaceId: s.activeWorkspaceId, onboardingOpen: s.onboardingOpen };
  },
} });
createRoot(document.getElementById('root')!).render(<UpdateProvider><App /></UpdateProvider>);
