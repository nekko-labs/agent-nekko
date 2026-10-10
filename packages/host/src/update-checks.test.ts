import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelInfo, VaizerCatalog } from '@agent-nekko/shared';
import { setDataDir } from './paths.js';
import { startUpdateChecks } from './update-checks.js';

const settings: AppSettings = {
  theme: 'dark',
  accent: '#6d5efc',
  sandboxMode: 'workspace-jail',
  providers: [
    { id: 'cg', kind: 'chatgpt', label: 'ChatGPT', baseUrl: 'https://chatgpt.com/backend-api', enabled: true },
    { id: 'off', kind: 'openai', label: 'Off', baseUrl: 'https://api.openai.com/v1', enabled: false },
  ],
  guardrails: [],
  workspaces: [],
  connectors: [],
  mascotEnabled: true,
};

const model = (id: string): ModelInfo => ({ id, providerId: 'cg', name: id });
const catalog = (ids: string[]): VaizerCatalog => ({
  marketplace: 'vaizer',
  skills: ids.map((id) => ({ id, name: id, slug: id, category: 'test', description: id, tier: 'community' as const, author: 'test' })),
  source: 'live',
});

function rig(opts: { models?: Record<string, ModelInfo[]>; skills?: VaizerCatalog; patch?: Partial<AppSettings> } = {}) {
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const lists: string[] = [];
  const svc = startUpdateChecks({
    settings: () => ({ ...settings, ...opts.patch }),
    listModels: async (id) => {
      lists.push(id);
      return opts.models?.[id] ?? [model('a')];
    },
    emit: (channel, payload) => emitted.push({ channel, payload }),
    fetchSkillsCatalog: async () => opts.skills ?? catalog(['x']),
    intervalMs: 60_000_000,
    startDelayMs: 60_000_000,
  });
  return { svc, emitted, lists };
}

beforeEach(() => {
  setDataDir(mkdtempSync(join(tmpdir(), 'nekko-updates-')));
  vi.restoreAllMocks();
});

describe('update-checks service', () => {
  it('seeds silently on the first run and emits when a list changes', async () => {
    const lists: ModelInfo[][] = [[model('a')], [model('a'), model('b')]];
    let i = 0;
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = startUpdateChecks({
      settings: () => settings,
      listModels: async () => lists[Math.min(i++, lists.length - 1)],
      emit: (channel, payload) => emitted.push({ channel, payload }),
      fetchSkillsCatalog: async () => catalog(['x']),
      intervalMs: 60_000_000,
      startDelayMs: 60_000_000,
    });
    await svc.runNow();
    await svc.runNow();
    expect(emitted).toEqual([{ channel: 'modelsUpdated', payload: { providerId: 'cg' } }]);
    svc.stop();
  });

  it('runs a manual check regardless of the toggles, and skips disabled providers', async () => {
    const { svc, emitted, lists } = rig({ patch: { updates: { modelLists: false, skills: false } } });
    await svc.runNow();
    expect(emitted).toHaveLength(0); // first observation only seeds
    expect(lists).toEqual(['cg']); // the disabled provider is skipped
    svc.stop();
  });

  it('gates scheduled ticks on the toggles', async () => {
    vi.useFakeTimers();
    try {
      const { svc, lists } = rig({ patch: { updates: { modelLists: false } } });
      await vi.advanceTimersByTimeAsync(60_000_001);
      expect(lists).toEqual([]);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }

    vi.useFakeTimers();
    try {
      const on = rig();
      await vi.advanceTimersByTimeAsync(60_000_001);
      expect(on.lists).toContain('cg');
      expect(on.lists).not.toContain('off');
      on.svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never snapshots an empty list, so a recovered provider is not a false diff', async () => {
    let n = 0;
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = startUpdateChecks({
      settings: () => settings,
      listModels: async () => (++n === 1 ? [] : [model('a')]),
      emit: (channel, payload) => emitted.push({ channel, payload }),
      fetchSkillsCatalog: async () => catalog(['x']),
      intervalMs: 60_000_000,
      startDelayMs: 60_000_000,
    });
    await svc.runNow();
    await svc.runNow();
    await svc.runNow();
    expect(emitted).toHaveLength(0);
    svc.stop();
  });

  it('emits skillsUpdated only when the skill set changes', async () => {
    const cats = [catalog(['x', 'y']), catalog(['x'])];
    let i = 0;
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = startUpdateChecks({
      settings: () => ({ ...settings, updates: { skills: true } }),
      listModels: async () => [],
      emit: (channel, payload) => emitted.push({ channel, payload }),
      fetchSkillsCatalog: async () => cats[Math.min(i++, cats.length - 1)],
      intervalMs: 60_000_000,
      startDelayMs: 60_000_000,
    });
    await svc.runNow();
    await svc.runNow();
    await svc.runNow();
    expect(emitted).toEqual([{ channel: 'skillsUpdated', payload: catalog(['x']) }]);
    svc.stop();
  });

  it('survives a failing check without losing the others', async () => {
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const svc = startUpdateChecks({
      settings: () => ({ ...settings, updates: { skills: true } }),
      listModels: async () => {
        throw new Error('boom');
      },
      emit: (channel, payload) => emitted.push({ channel, payload }),
      fetchSkillsCatalog: async () => catalog(['x']),
      intervalMs: 60_000_000,
      startDelayMs: 60_000_000,
    });
    await expect(svc.runNow()).resolves.toBeUndefined();
    svc.stop();
  });
});
