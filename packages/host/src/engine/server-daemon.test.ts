import { describe, expect, it } from 'vitest';
import type { EngineSettings, LocalModel } from '@nekko-agent/shared';
import { DEFAULT_ENGINE_SETTINGS } from '@nekko-agent/shared';
import type { DaemonChild, DaemonSpawnSpec, EngineDaemon } from './daemon.js';
import { createEngineServer } from './server.js';

/**
 * The TS router under the engine daemon: it keeps the policy and hands every
 * process and the listening port to the daemon. The daemon here is an
 * in-memory stand-in; the real one is covered by crates/nekko-infer's tests.
 */

const model = (id: string, extra: Partial<LocalModel> = {}): LocalModel => ({
  id,
  name: id,
  path: `/models/${id}.gguf`,
  sizeBytes: 4_000_000_000,
  addedAt: 0,
  ...extra,
});

function fakeDaemon(opts: { fail?: string[] } = {}) {
  const children = new Map<string, DaemonChild>();
  const spawned: DaemonSpawnSpec[] = [];
  let serving: { port: number; host: string } | null = null;
  const served: unknown[] = [];
  let nextPort = 40000;
  const daemon: EngineDaemon = {
    serve: async (cfg) => {
      served.push(cfg);
      serving = { port: cfg.port, host: cfg.host };
      return { ok: true, message: 'serving' };
    },
    stopServing: async () => {
      serving = null;
    },
    serving: async () => serving,
    spawn: async (spec) => {
      spawned.push(spec);
      if (opts.fail?.includes(spec.modelId)) {
        return { status: 'failed', message: 'The model server exited (exit code: 1).', log: ['llama_model_load: error loading model: failed to allocate buffer'] };
      }
      const c = { modelId: spec.modelId, kind: spec.kind, port: nextPort++, pid: 1234, startedAt: 1, lastUsedAt: 1, activeRequests: 0 };
      children.set(spec.modelId, c);
      return { status: 'ready', port: c.port, pid: c.pid };
    },
    kill: async (id) => children.delete(id),
    list: async () => [...children.values()],
  };
  return { daemon, children, spawned, served, isServing: () => serving !== null };
}

function make(daemon: EngineDaemon, settings: Partial<EngineSettings> = {}, models: LocalModel[] = [model('qwen3-8b'), model('sdxl', { modality: 'image' })]) {
  const current: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...settings };
  return createEngineServer({
    settings: () => current,
    binPath: async () => '/engine/llama-server',
    diffusionBinPath: async () => '/engine/sd-server',
    findModel: async (id) => models.find((m) => m.id === id),
    listModels: async () => models,
    getGpuStats: async () => null,
    flagSupport: async () => () => true,
    daemon,
  });
}

describe('the engine under the daemon', () => {
  it('serves through the daemon with the endpoint settings', async () => {
    const d = fakeDaemon();
    const server = make(d.daemon, { port: 11600, apiKey: 'k', corsOrigins: 'http://a.test, *' });
    const res = await server.start();
    expect(res.ok).toBe(true);
    expect(d.served[0]).toEqual({ port: 11600, host: '127.0.0.1', apiKey: 'k', corsOrigins: ['http://a.test', '*'] });
    expect(server.isRunning()).toBe(true);
    await server.stop();
    expect(d.isServing()).toBe(false);
  });

  it('loads by asking the daemon to spawn, with the port left for it to fill', async () => {
    const d = fakeDaemon();
    const server = make(d.daemon);
    await server.start();
    const res = await server.load('qwen3-8b', { contextTokens: 8192 });
    expect(res.ok, res.message).toBe(true);
    const spec = d.spawned[0];
    expect(spec.bin).toBe('/engine/llama-server');
    expect(spec.args[spec.args.indexOf('--port') + 1]).toBe('{port}');
    expect(spec.args).toContain('--spec-default');
    expect(spec).toMatchObject({ kind: 'chat', healthPath: '/health', healthExpect: '"ok"' });
    expect(server.loadedIds()).toEqual(['qwen3-8b']);
    await server.unload('qwen3-8b');
    expect(d.children.size).toBe(0);
    await server.stop();
  });

  it('explains a failed load from the log the daemon sends back', async () => {
    const d = fakeDaemon({ fail: ['qwen3-8b'] });
    const server = make(d.daemon);
    await server.start();
    const res = await server.load('qwen3-8b', {});
    expect(res.ok).toBe(false);
    expect(server.loadErrorFor('qwen3-8b')).toBeTruthy();
    expect(server.loadedIds()).toEqual([]);
    await server.stop();
  });

  it('forgets a model the daemon no longer has (it crashed)', async () => {
    const d = fakeDaemon();
    const server = make(d.daemon);
    await server.start();
    await server.load('qwen3-8b', {});
    d.children.clear();
    await server.sync();
    expect(server.loadedIds()).toEqual([]);
    await server.stop();
  });

  it("answers the daemon router's load requests like its own listener would", async () => {
    const d = fakeDaemon();
    const server = make(d.daemon);
    await server.start();
    expect(await server.routerLoad('nope', false)).toMatchObject({ ok: false, status: 404 });
    expect(await server.routerLoad('sdxl', false)).toMatchObject({ ok: false, status: 400 });
    expect(await server.routerLoad('qwen3-8b', true)).toMatchObject({ ok: false, status: 400 });
    expect(await server.routerLoad('qwen3-8b', false)).toEqual({ ok: true });
    expect(d.spawned).toHaveLength(1);
    const listed = await server.routerModels();
    expect(listed.data.find((m) => m.id === 'qwen3-8b')?.state).toBe('loaded');
    await server.stop();
  });

  it('refuses to load on demand when load-on-demand is off', async () => {
    const d = fakeDaemon();
    const server = make(d.daemon, { jitLoad: false });
    await server.start();
    expect(await server.routerLoad('qwen3-8b', false)).toMatchObject({ ok: false, status: 409 });
    await server.stop();
  });

  it('gives image models the diffusion binary and its health route', async () => {
    const d = fakeDaemon();
    const server = make(d.daemon);
    await server.start();
    await server.load('sdxl', {});
    expect(d.spawned[0]).toMatchObject({ bin: '/engine/sd-server', kind: 'image', healthPath: '/v1/models' });
    await server.stop();
  });

  it('picks up models still running after a backend restart', async () => {
    const d = fakeDaemon();
    const first = make(d.daemon);
    await first.start();
    await first.load('qwen3-8b', {});
    // A new backend process: a fresh engine against the same daemon.
    const second = make(d.daemon);
    await second.reattach();
    expect(second.isRunning()).toBe(true);
    expect(second.loadedIds()).toEqual(['qwen3-8b']);
    await second.stop();
  });

  it('re-serves on new endpoint settings without unloading models', async () => {
    const d = fakeDaemon();
    const settings: Partial<EngineSettings> = { port: 11601 };
    const server = make(d.daemon, settings);
    await server.start();
    await server.load('qwen3-8b', {});
    await server.reconfigure();
    expect(d.served).toHaveLength(2);
    expect(d.children.size).toBe(1);
    await server.stop();
  });
});
