/**
 * The engine daemon's model-server channels (`crates/nekko-infer`), seen from
 * the TS engine.
 *
 * When this host runs as the desktop app's backend under `nekkod`, the daemon
 * owns every model-server process and the OpenAI-compatible port; the TS
 * engine keeps choosing what to load and with which arguments, and asks the
 * daemon to run it. Absent in the web and server editions, where
 * `server.ts` still spawns and proxies itself.
 */

export interface DaemonSpawnSpec {
  modelId: string;
  bin: string;
  /** With `{port}` where the listening port goes; the daemon picks the port. */
  args: string[];
  env?: Record<string, string>;
  kind: 'chat' | 'image';
  /** GET this path; a 200 means ready. */
  healthPath: string;
  /** And the body must contain this, when set. */
  healthExpect?: string;
  budgetSecs?: number;
}

export type DaemonSpawnOutcome =
  | { status: 'ready'; port: number; pid: number }
  | { status: 'failed'; message: string; log: string[] };

export interface DaemonChild {
  modelId: string;
  kind: 'chat' | 'image';
  port: number;
  pid: number;
  startedAt: number;
  lastUsedAt: number;
  activeRequests: number;
}

export interface EngineDaemon {
  serve(cfg: { port: number; host: string; apiKey?: string; corsOrigins: string[] }): Promise<{ ok: boolean; message: string }>;
  stopServing(): Promise<void>;
  /** The configuration the router is listening with, or null when it is not. */
  serving(): Promise<{ port: number; host: string } | null>;
  spawn(spec: DaemonSpawnSpec): Promise<DaemonSpawnOutcome>;
  kill(modelId: string): Promise<boolean>;
  list(): Promise<DaemonChild[]>;
}

/** Where `{port}` goes in a daemon spawn's arguments. */
export const DAEMON_PORT = '{port}';

let current: EngineDaemon | undefined;

/** Hand the model servers to the engine daemon (desktop backend under nekkod). */
export function useEngineDaemon(link: { url: string; token: string } | null): void {
  current = link ? daemonClient(link) : undefined;
}

export function engineDaemon(): EngineDaemon | undefined {
  return current;
}

export function daemonClient(link: { url: string; token: string }): EngineDaemon {
  const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
    const res = await fetch(`${link.url}/api/${channel}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${link.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(body?.error ?? `${channel}: HTTP ${res.status}`);
    return body as T;
  };
  return {
    serve: (cfg) =>
      call<{ ok: boolean; message: string }>('infer:serve', cfg).catch((e: Error) => ({ ok: false, message: e.message })),
    stopServing: () => call('infer:stopServing'),
    serving: () => call('infer:serving'),
    spawn: (spec) => call('infer:spawn', spec),
    kill: (modelId) => call('infer:kill', modelId),
    list: () => call('infer:list'),
  };
}
