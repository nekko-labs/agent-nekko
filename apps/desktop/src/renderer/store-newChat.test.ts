import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@nekko-agent/shared';
import { __resetSessionCache, getCachedSession } from './sessionCache.js';

vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { innerWidth: 1280, addEventListener() {} };
});
const { useStore } = await import('./store.js');
const created: Session = { id: 'new_chat', title: 'New chat', createdAt: 1, updatedAt: 1, messages: [], providerId: 'p', modelId: 'm' };

beforeEach(() => {
  __resetSessionCache();
  useStore.setState({ sessions: [], workspaces: [], activeWorkspaceId: null, activeProjectId: null, providers: [], models: [], activeProviderId: null, activeModelId: null });
});

describe('new-chat first frame', () => {
  it('caches the creation record before the pane opens', async () => {
    window.nekko = { createSession: vi.fn().mockResolvedValue(created), listProviders: vi.fn().mockResolvedValue([{ id: 'p', kind: 'chatgpt', enabled: true }]), listModels: vi.fn().mockResolvedValue([]) } as unknown as typeof window.nekko;
    const open = vi.spyOn(useStore.getState(), 'openChatPane').mockImplementation((id) => {
      expect(getCachedSession(id)).toBe(created);
    });
    try {
      await useStore.getState().newChat();
      expect(open).toHaveBeenCalledWith(created.id);
      expect(useStore.getState().activeSessionId).toBe(created.id);
    } finally { open.mockRestore(); }
  });
  it('caches image options rather than the unconfigured creation record', async () => {
    const image = { ...created, chatType: 'image' as const, imageParams: { modelId: 'image-model' } };
    window.nekko = {
      createSession: vi.fn().mockResolvedValue(created),
      setSessionOptions: vi.fn().mockResolvedValue(image),
    } as unknown as typeof window.nekko;
    const open = vi.spyOn(useStore.getState(), 'openChatPane').mockImplementation((id) => {
      expect(getCachedSession(id)).toBe(image);
    });
    try { await useStore.getState().newImageChat('image-model'); }
    finally { open.mockRestore(); }
  });
});

it('routes an unconfigured first agent to setup without creating an empty session', async () => {
  window.nekko = { listProviders: vi.fn().mockResolvedValue([{ id: 'nekko-engine', kind: 'llamacpp', enabled: true }]), listModels: vi.fn().mockResolvedValue([]), createSession: vi.fn() } as unknown as typeof window.nekko;
  await useStore.getState().newChat();
  expect(useStore.getState().view).toBe('models');
  expect(window.nekko.createSession).not.toHaveBeenCalled();
});
