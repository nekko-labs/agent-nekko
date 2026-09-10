import {
  DEFAULT_FIT_REQUEST,
  isRuntimeKind,
  RUNTIME_CAPABILITIES,
  type FitPlan,
  type FitRequest,
  type HardwareFacts,
  type LoadParams,
  type LoadResult,
  type ModelFacts,
  type ProviderConfig,
  type RuntimeKind,
  type RuntimeStatus,
  type StopResult,
  type SystemStats,
  type GpuStats,
} from '@agent-nekko/shared';
import { planFit } from '@agent-nekko/core';
import { execFile } from 'child_process';
import { createOllamaAdapter } from './ollama.js';
import { createLmStudioAdapter } from './lmstudio.js';
import { createVllmAdapter } from './vllm.js';
import { createSupervisor } from './supervisor.js';
import { overheadFloorFor, recordMeasurement } from './calibration.js';
import type { RuntimeAdapter, RuntimeContext } from './types.js';

/**
 * The runtime control plane, as the host sees it.
 *
 * This is the join point: adapters supply model facts, the GPU and system probes
 * supply hardware facts, calibration supplies the overhead floor, and the pure
 * planner turns all three into a projection. Everything above this (IPC, the
 * renderer) deals in providers and models, never in adapters.
 */

const MB = 1024 * 1024;

export interface RuntimesDeps {
  findProvider: (id: string) => ProviderConfig | undefined;
  getGpuStats: () => Promise<GpuStats | null>;
  getSystemStats: () => Promise<SystemStats | null>;
  ctx?: RuntimeContext;
}

/** How each runtime is launched, for the ones we are willing to launch. */
const START_COMMANDS: Partial<Record<RuntimeKind, { cmd: string; args: string[] }>> = {
  ollama: { cmd: 'ollama', args: ['serve'] },
  // lmstudio starts through its own CLI inside the adapter, not the supervisor.
  // vllm is deliberately absent: we never start it.
};

export function createRuntimes(deps: RuntimesDeps) {
  const ctx: RuntimeContext = deps.ctx ?? {
    fetch: globalThis.fetch,
    run: (cmd, args, timeoutMs = 5000) =>
      new Promise<string | null>((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
          const text = `${stdout ?? ''}${stderr ?? ''}`;
          resolve(err && !text ? null : text);
        });
      }),
  };

  const adapters: Record<RuntimeKind, RuntimeAdapter> = {
    ollama: createOllamaAdapter(ctx),
    lmstudio: createLmStudioAdapter(ctx),
    vllm: createVllmAdapter(ctx),
  };

  const supervisor = createSupervisor({
    healthy: async (baseUrl) => {
      try {
        const res = await ctx.fetch(`${baseUrl.replace(/\/+$/, '')}/api/version`);
        if (res.ok) return true;
      } catch {
        /* fall through to the OpenAI-compatible probe */
      }
      try {
        return (await ctx.fetch(`${baseUrl.replace(/\/+$/, '')}/models`)).ok;
      } catch {
        return false;
      }
    },
  });

  /** The adapter for a provider, or null when it is not a local runtime. */
  function resolve(
    providerId: string,
  ): { adapter: RuntimeAdapter; provider: ProviderConfig; kind: RuntimeKind } | null {
    const provider = deps.findProvider(providerId);
    if (!provider || !isRuntimeKind(provider.kind)) return null;
    return { adapter: adapters[provider.kind], provider, kind: provider.kind };
  }

  /**
   * Hardware, in bytes.
   *
   * GpuStats reports megabytes, and on Apple Silicon its totals are already
   * system RAM (the `unified` flag says so). Passing that flag through is what
   * stops the planner adding the same bytes to themselves.
   */
  async function hardware(): Promise<HardwareFacts> {
    const [gpu, sys] = await Promise.all([deps.getGpuStats(), deps.getSystemStats()]);
    return {
      devices: (gpu?.devices ?? []).map((d) => ({
        name: d.name,
        totalBytes: d.memoryTotalMB * MB,
        freeBytes: d.memoryFreeMB * MB,
      })),
      unified: Boolean(gpu?.unified),
      systemRamTotalBytes: (sys?.memTotalMB ?? 0) * MB,
      systemRamFreeBytes: Math.max(0, (sys?.memTotalMB ?? 0) - (sys?.memUsedMB ?? 0)) * MB,
    };
  }

  async function status(providerId: string): Promise<RuntimeStatus | null> {
    const found = resolve(providerId);
    if (!found) return null;
    const s = await found.adapter.status(found.provider.baseUrl);
    // Only the supervisor knows whether the process is ours.
    return {
      ...s,
      owned: supervisor.isOwned(providerId),
      startedAt: supervisor.startedAt(providerId) ?? s.startedAt,
      log: supervisor.logs(providerId).slice(-20).length ? supervisor.logs(providerId).slice(-20) : s.log,
    };
  }

  async function start(providerId: string): Promise<RuntimeStatus | { error: string }> {
    const found = resolve(providerId);
    if (!found) return { error: 'Not a local model server.' };
    const { adapter, provider } = found;

    if (!adapter.capabilities.canStart) {
      const detection = await adapter.detect(provider.baseUrl);
      return { error: detection.reason ?? 'This runtime cannot be started from here.' };
    }

    // LM Studio has its own lifecycle command and manages its own process.
    if (adapter.start && found.kind === 'lmstudio') {
      const s = await adapter.start({ baseUrl: provider.baseUrl });
      return s.error ? { error: s.error } : s;
    }

    const spec = START_COMMANDS[found.kind];
    if (!spec) return { error: 'No launch command is defined for this runtime.' };

    const detection = await adapter.detect(provider.baseUrl);
    if (!detection.installed) {
      return { error: detection.reason ?? `${found.kind} was not found on this machine.` };
    }

    const outcome = await supervisor.start({
      id: providerId,
      baseUrl: provider.baseUrl,
      cmd: spec.cmd,
      args: spec.args,
      env: envFor(provider),
    });
    if (!outcome.ok) return { error: outcome.error ?? 'The server did not start.' };
    return (await status(providerId)) ?? { error: 'Started, but the server is not answering yet.' };
  }

  async function stop(providerId: string, force = false): Promise<StopResult> {
    const found = resolve(providerId);
    if (!found) return { ok: false, message: 'Only local model servers can be stopped from here.' };
    const { adapter, provider } = found;

    // A process we started is ours to stop, whatever the runtime is.
    if (supervisor.isOwned(providerId)) return supervisor.stop(providerId, provider.baseUrl, force);

    // LM Studio has a real shutdown command, so it never needs a port kill.
    if (found.kind === 'lmstudio' && adapter.stop) return adapter.stop(provider.baseUrl);

    return supervisor.stop(providerId, provider.baseUrl, force);
  }

  async function facts(providerId: string): Promise<ModelFacts[]> {
    const found = resolve(providerId);
    if (!found) return [];
    try {
      return await found.adapter.listModels(found.provider.baseUrl);
    } catch {
      return [];
    }
  }

  /** The projection for one model, with the machine's real numbers behind it. */
  async function plan(
    providerId: string,
    modelId: string,
    req: FitRequest = DEFAULT_FIT_REQUEST,
  ): Promise<FitPlan | null> {
    const found = resolve(providerId);
    if (!found) return null;
    const all = await facts(providerId);
    const model = all.find((m) => m.id === modelId);
    if (!model) return null;

    const detection = await found.adapter.detect(found.provider.baseUrl);
    return planFit(model, req, await hardware(), {
      overheadFloorBytes: overheadFloorFor(found.adapter.kind, detection.version),
      siblings: all,
    });
  }

  async function load(providerId: string, modelId: string, params: LoadParams): Promise<LoadResult> {
    const found = resolve(providerId);
    const loadFn = found?.adapter.load;
    if (!found || !loadFn) return { ok: false, message: 'This runtime loads its model at launch.' };
    const { adapter, provider } = found;

    // The projection we are about to check ourselves against.
    const projected = await plan(providerId, modelId, {
      ...DEFAULT_FIT_REQUEST,
      ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
      ...(params.kvCacheDtype ? { kvCacheDtype: params.kvCacheDtype } : {}),
    });

    const result = await loadFn.call(adapter, provider.baseUrl, modelId, params);
    if (!result.ok) return result;

    // Reconcile: what the runtime actually took versus what we said it would.
    // An estimate nobody checks is an estimate nobody should trust.
    if (projected && adapter.capabilities.reportsPerModelVram) {
      const after = await adapter.status(provider.baseUrl);
      const measured = after.resident.find((r) => r.id === modelId);
      const detection = await adapter.detect(provider.baseUrl);
      if (measured?.sizeBytes) {
        recordMeasurement(
          adapter.kind,
          detection.version,
          measured.sizeBytes,
          projected.requiredBytes,
          projected.overheadBytes,
        );
      }
    }
    return result;
  }

  async function unload(providerId: string, modelId: string): Promise<LoadResult> {
    const found = resolve(providerId);
    const unloadFn = found?.adapter.unload;
    if (!found || !unloadFn) return { ok: false, message: 'This runtime cannot unload a single model.' };
    return unloadFn.call(found.adapter, found.provider.baseUrl, modelId);
  }

  function capabilities(providerId: string) {
    const provider = deps.findProvider(providerId);
    if (!provider || !isRuntimeKind(provider.kind)) return null;
    return RUNTIME_CAPABILITIES[provider.kind];
  }

  return { status, start, stop, load, unload, facts, plan, capabilities, hardware };
}

export type Runtimes = ReturnType<typeof createRuntimes>;

/**
 * Server-wide settings Ollama only reads at startup, so this is the one moment
 * they can be applied. Anything not set here keeps Ollama's own default.
 */
function envFor(provider: ProviderConfig): Record<string, string> | undefined {
  if (provider.kind !== 'ollama') return undefined;
  try {
    const url = new URL(provider.baseUrl);
    return { OLLAMA_HOST: `${url.hostname}:${url.port || '11434'}` };
  } catch {
    return undefined;
  }
}

export * from './types.js';
export { parseVllmMetrics } from './vllm.js';
export { overheadFloorFor, recordMeasurement, resetCalibration } from './calibration.js';
