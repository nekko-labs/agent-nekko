import {
  RUNTIME_CAPABILITIES,
  type LoadParams,
  type LoadResult,
  type ModelFacts,
  type RuntimeDetection,
  type RuntimeStatus,
  type StopResult,
} from '@agent-nekko/shared';
import type { Engine } from '../engine/index.js';
import type { RuntimeAdapter } from './types.js';

/**
 * The Nekko engine, behind the same adapter contract as everybody else's server.
 *
 * This is the payoff from T149 doing the abstraction first: the renderer gets a
 * fourth runtime with a power toggle, a resident-model list, a fit drawer and
 * load controls without one line of runtime-kind branching, because it asks the
 * capability row and this one simply says yes to more of it.
 *
 * Unlike the other three it does no HTTP to discover anything. The engine is
 * in-process, so `detect` and `status` are questions we can answer directly, and
 * `baseUrl` is an output (where we are serving) rather than an input (where to
 * look for somebody else's server).
 */
export function createLlamaCppAdapter(engine: Engine): RuntimeAdapter {
  return {
    kind: 'llamacpp',
    capabilities: RUNTIME_CAPABILITIES.llamacpp,

    async detect(baseUrl: string): Promise<RuntimeDetection> {
      const install = await engine.detectEngine();
      return {
        kind: 'llamacpp',
        running: engine.isRunning(),
        // "Installed" here means an engine binary is usable, which is the thing
        // that decides whether Start can work.
        installed: Boolean(install.binPath),
        version: install.version,
        reason: install.binPath ? undefined : install.reason,
      };
    },

    async status(baseUrl: string): Promise<RuntimeStatus> {
      const state = await engine.status();
      return {
        kind: 'llamacpp',
        running: state.running,
        installed: Boolean(state.install.binPath),
        reason: state.install.binPath ? undefined : state.install.reason,
        // Always ours: there is no other process this could be.
        owned: state.running,
        version: state.install.version,
        baseUrl,
        startedAt: state.startedAt,
        resident: state.resident,
        log: state.log,
      };
    },

    /**
     * The library, as facts for the planner.
     *
     * These are the most complete facts any adapter produces, because they come
     * from each file's own GGUF header rather than from a server's API: layers,
     * KV heads and head dimension are all present, so the projection is exact
     * rather than partial.
     */
    async listModels(baseUrl: string): Promise<ModelFacts[]> {
      const models = await engine.models();
      const resident = new Map(engine.resident().map((r) => [r.id, r]));
      return models.map((m) => {
        const live = resident.get(m.id);
        return {
          id: m.id,
          providerId: baseUrl,
          weightsBytes: m.sizeBytes,
          layers: m.layers,
          kvHeads: m.kvHeads,
          headDim: m.headDim,
          maxContext: m.maxContext,
          quantization: m.quantization,
          parameterSize: m.parameterSize,
          loaded: m.loaded,
          vramBytes: live?.vramBytes,
          loadedContext: live?.contextLength,
        };
      });
    },

    async start(): Promise<RuntimeStatus> {
      const res = await engine.start();
      const state = await engine.status();
      return {
        kind: 'llamacpp',
        running: state.running,
        installed: Boolean(state.install.binPath),
        owned: state.running,
        version: state.install.version,
        baseUrl: `http://127.0.0.1:${state.port}/v1`,
        startedAt: state.startedAt,
        resident: state.resident,
        log: state.log,
        error: res.ok ? undefined : res.message,
      };
    },

    stop(): Promise<StopResult> {
      // Never a port kill: every process involved is one we spawned, so there is
      // nothing here to ask permission about.
      return engine.stop();
    },

    load(_baseUrl: string, modelId: string, params: LoadParams): Promise<LoadResult> {
      return engine.load(modelId, params);
    },

    unload(_baseUrl: string, modelId: string): Promise<LoadResult> {
      return engine.unload(modelId);
    },
  };
}
