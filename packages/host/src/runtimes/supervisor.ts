import { spawn, type ChildProcess } from 'child_process';
import type { StopResult } from '@agent-nekko/shared';
import { stopLocalServer } from '../servers.js';

/**
 * Ownership of the model servers we start.
 *
 * The distinction this module exists to draw: a server we spawned is ours, and we
 * stop it with its own handle. A server we merely found on a port is not, and
 * killing it without asking is how you take down a system service somebody else
 * depends on. The old behaviour (kill whatever holds the port, silently) stays as
 * the forced path, but it is no longer the default.
 */

export interface SpawnedRuntime {
  child: ChildProcess;
  startedAt: number;
  log: string[];
}

/** Keep the tail only. A server that has run for hours must not grow unbounded. */
const LOG_LINES = 200;
/** A cold start off a slow disk is genuinely slow. */
const START_BUDGET_MS = 60_000;
const HEALTH_INTERVAL_MS = 500;
/** Grace between asking a process to stop and insisting. */
const SIGKILL_DELAY_MS = 3000;

export interface SupervisorDeps {
  /** Injected so tests do not need a real server to poll. */
  healthy: (baseUrl: string) => Promise<boolean>;
  spawnFn?: typeof spawn;
  now?: () => number;
}

export interface StartRequest {
  id: string;
  baseUrl: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export interface StartOutcome {
  ok: boolean;
  startedAt?: number;
  log: string[];
  error?: string;
}

export function createSupervisor(deps: SupervisorDeps) {
  const owned = new Map<string, SpawnedRuntime>();
  const spawnFn = deps.spawnFn ?? spawn;
  const now = deps.now ?? Date.now;

  // Quitting Agent Nekko must not leave orphaned model servers holding VRAM.
  const killAll = () => {
    for (const { child } of owned.values()) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  };
  process.once('exit', killAll);

  async function start(req: StartRequest): Promise<StartOutcome> {
    if (owned.has(req.id)) {
      return { ok: true, startedAt: owned.get(req.id)!.startedAt, log: owned.get(req.id)!.log };
    }
    if (await deps.healthy(req.baseUrl)) {
      // Something is already serving this address. Adopting it would mean
      // claiming ownership of a process we did not start.
      return { ok: true, log: ['A server is already running at this address.'] };
    }

    const log: string[] = [];
    let child: ChildProcess;
    try {
      child = spawnFn(req.cmd, req.args, {
        env: { ...process.env, ...req.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return { ok: false, log, error: (e as Error).message };
    }

    const capture = (buf: Buffer | string) => {
      for (const line of String(buf).split('\n')) {
        if (line.trim()) log.push(line.trimEnd());
      }
      if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    let exited: string | null = null;
    child.on('error', (e) => {
      exited = e.message;
    });
    child.on('exit', (code) => {
      exited = exited ?? `The server exited with code ${code}.`;
      owned.delete(req.id);
    });

    const startedAt = now();
    const deadline = startedAt + START_BUDGET_MS;
    while (now() < deadline) {
      if (exited) {
        // The captured output is the whole point: "port already in use" and
        // "command not found" are different problems with different fixes.
        return { ok: false, log, error: log.slice(-3).join(' ') || exited };
      }
      if (await deps.healthy(req.baseUrl)) {
        owned.set(req.id, { child, startedAt, log });
        return { ok: true, startedAt, log };
      }
      await sleep(HEALTH_INTERVAL_MS);
    }

    try {
      child.kill('SIGTERM');
    } catch {
      /* nothing to kill */
    }
    return { ok: false, log, error: 'The server did not become reachable in time.' };
  }

  /**
   * Stop a runtime. Ours goes down without ceremony; somebody else's needs a yes,
   * which is what `needsConfirmation` asks for.
   */
  async function stop(id: string, baseUrl: string, force = false): Promise<StopResult> {
    const mine = owned.get(id);
    if (mine) {
      try {
        mine.child.kill('SIGTERM');
        const timer = setTimeout(() => {
          try {
            mine.child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, SIGKILL_DELAY_MS);
        timer.unref?.();
      } catch {
        /* already gone */
      }
      owned.delete(id);
      return { ok: true, message: 'Stopped the server.' };
    }

    if (!force) {
      return {
        ok: false,
        message:
          'This server was not started by Agent Nekko. Stopping it means ending a process something else may be using.',
        needsConfirmation: true,
        processName: baseUrl,
      };
    }
    return stopLocalServer(baseUrl);
  }

  return {
    start,
    stop,
    isOwned: (id: string) => owned.has(id),
    startedAt: (id: string) => owned.get(id)?.startedAt,
    logs: (id: string) => owned.get(id)?.log ?? [],
  };
}

export type Supervisor = ReturnType<typeof createSupervisor>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
