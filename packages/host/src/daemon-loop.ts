import { randomBytes } from 'crypto';
import { appendAgentTerminal } from './terminal.js';
import { getSession, saveSession } from './sessions.js';
import type { AgentEvent, ChatMessage, EffortLevel, ProviderConfig, ToolCall, ToolResult } from '@nekko-agent/shared';

/**
 * A chat turn's run, driven by the engine daemon (`loop:run`, crates/nekkod
 * src/loops.rs) instead of `runAgent` in this process.
 *
 * Everything that decides the turn stays here: the provider (with a fresh
 * token), the tools on offer, the system prompt and context. The tools run
 * here too, through `loop:tool`, so approvals, questions, MCP and sub-agents
 * behave exactly as before, except the built-in file and shell tools named in
 * `toolContext.native`: the daemon runs those itself (`nekko-tools`) and asks
 * here only to approve (`loop:approve`) and to log commands (`loop:log`). What moves is the streaming loop: the daemon
 * sends each event to the UI itself, in order, and this side hears about them
 * through `loop:event` to save checkpoints, record usage and wait on people.
 *
 * `runAgentViaDaemon` yields the same events `runAgent` does, so the turn code
 * that consumes them is unchanged. Each carries `relayOnly: true`: the UI
 * already has it from the daemon, and this host's re-emit is only for its own
 * listeners (the phone relay, messaging), which the daemon does not forward.
 * A reply's final event is acknowledged only after it has been consumed, so
 * the transcript is saved before the daemon lets the UI see `done`.
 *
 * The daemon is another process, and it can die or be restarted mid-run. A
 * run whose events simply stop would otherwise wait here for ever, so while
 * nothing arrives this side asks `loop:alive` every so often and ends the run
 * as interrupted when the daemon no longer knows it (or cannot be reached).
 */

type Call = <T>(channel: string, ...args: unknown[]) => Promise<T>;
type Severity = 'low' | 'medium' | 'high';

interface Run {
  execute: (call: ToolCall) => Promise<ToolResult>;
  approve: (call: ToolCall, reason: string, severity: Severity) => Promise<boolean>;
  deliver: (events: AgentEvent[], history?: ChatMessage[]) => Promise<void>;
  end: (history?: ChatMessage[]) => void;
}

// Match the daemon's bounded loop:run HTTP body (crates/nekkod/src/wire.rs).
const LOOP_RUN_BODY_LIMIT = 64 * 1024 * 1024;

const runs = new Map<string, Run>();

let owned: Promise<string[]> | undefined;
/** Whether the engine daemon serves `channel` itself (`daemon:info`, asked once). */
export async function daemonOwns(call: Call, channel: string): Promise<boolean> {
  owned ??= call<{ owned?: string[] }>('daemon:info')
    .then((info) => info?.owned ?? [])
    .catch(() => {
      owned = undefined;
      return [];
    });
  return (await owned).includes(channel);
}

/**
 * What a daemon advertises (in `daemon:info` `owned`) when its `loop:run`
 * has no tool-step limit. Daemons built before the limit was removed read the
 * budget a host sends (or leaves out) as a real cap, which once turned
 * "unlimited" into "zero steps"; a daemon that does not advertise this never
 * gets a run, and the turn runs in this process instead.
 */
export const UNBOUNDED_LOOP = 'loop:unbounded';

/** `loop:alive`: whether a run id is still being driven. Older daemons lack it. */
export const LOOP_ALIVE = 'loop:alive';

/** How long a run may stay silent before this side checks the daemon still has it. */
export const LIVENESS_INTERVAL_MS = 30_000;
/** Consecutive failed liveness probes before the daemon counts as gone. */
export const LIVENESS_STRIKES = 2;

/** Whether the daemon can drive a chat turn: it serves `loop:run` with no step limit. */
export async function daemonRunsLoops(call: Call): Promise<boolean> {
  return (await daemonOwns(call, 'loop:run')) && (await daemonOwns(call, UNBOUNDED_LOOP));
}

/** `loop:tool`: run one tool call of a daemon-driven run. */
export async function loopTool(runId: string, call: ToolCall): Promise<ToolResult> {
  const run = runs.get(runId);
  if (!run) return { toolCallId: call?.id ?? '', output: 'This run has already ended.', isError: true };
  return run.execute(call);
}

/** `loop:approve`: ask the user about a tool call the daemon runs itself. */
export async function loopApprove(runId: string, call: ToolCall, reason: string, severity: Severity): Promise<boolean> {
  const run = runs.get(runId);
  return run ? run.approve(call, reason, severity) : false;
}

/** `loop:log`: a line for a chat's agent command terminal, from a command the daemon ran. */
export function loopLog(sessionId: string, workspaceId: string | undefined, data: string): void {
  appendAgentTerminal(sessionId, workspaceId, data);
}

/**
 * A run this host does not know: it was started by a host the daemon has
 * since restarted. The daemon drives it on and the UI sees its events, but
 * nothing would save its transcript, so the checkpoints are written straight
 * to the session here. Nothing is sent on: the UI already has the events.
 */
function adoptOrphan(sessionId: string | undefined, history: ChatMessage[] | undefined, ended: boolean): void {
  if (!sessionId || !Array.isArray(history)) return;
  const session = getSession(sessionId);
  if (!session || session.incognito) return;
  session.messages = history;
  if (ended) delete session.activeRun;
  saveSession(session);
}

/** `loop:event`: events (and, at a checkpoint, the transcript) from a daemon-driven run. */
export async function loopEvent(runId: string, payload: { events?: AgentEvent[]; history?: ChatMessage[] }): Promise<void> {
  const run = runs.get(runId);
  if (!run) {
    const events = payload?.events ?? [];
    // Orphan usage cannot safely be attributed from session settings: routing may
    // have used another provider/model. The daemon currently sends only counters
    // and sessionId, with no accounting identity or replay-safe usage-event ID.
    // Preserve checkpoints, but do not guess billing metadata or double-count.
    adoptOrphan(events[0]?.sessionId, payload?.history, events.some((e) => e.type === 'done' || e.type === 'error'));
    return;
  }
  await run.deliver(payload?.events ?? [], payload?.history);
}

/** `loop:end`: the run is over; this is its final transcript. */
export function loopEnd(runId: string, payload: { history?: ChatMessage[]; sessionId?: string }): void {
  const run = runs.get(runId);
  if (!run) {
    adoptOrphan(payload?.sessionId, payload?.history, true);
    return;
  }
  run.end(payload?.history);
}

/** The Rust side of `ToolHostOptions` (crates/nekko-tools `ToolContext`). */
export interface DaemonToolContext {
  /** Tool names the daemon may run itself. */
  native: string[];
  sessionId: string;
  mode?: string;
  sandboxMode?: string;
  guardrails?: unknown;
  workspaces: Array<{ id: string; path: string }>;
  defaultCwd?: string;
}

export interface DaemonRunOptions {
  sessionId: string;
  provider: ProviderConfig;
  model: string;
  system: string;
  /** The transcript; replaced in place as the daemon reports it, as `runAgent` appends to it. */
  history: ChatMessage[];
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  /** The approval prompt, for the tools the daemon runs itself. */
  requestApproval?: (call: ToolCall, reason: string, severity: Severity) => Promise<boolean>;
  /** What the daemon needs to run the built-in tools in `native` itself; left out, every tool runs here. */
  toolContext?: DaemonToolContext;
  signal?: AbortSignal;
  temperature?: number;
  effort?: EffortLevel;
  think?: boolean;
  promptCaching?: boolean;
  maxHistoryTurns?: number;
  maxOutputTokens?: number;
  resume?: boolean;
  /** How often a silent run is checked on (tests shorten it). */
  livenessIntervalMs?: number;
  /** Told the run's id as soon as it has one, for `loop:steer`. */
  onRunId?: (runId: string) => void;
}

export async function* runAgentViaDaemon(call: Call, opts: DaemonRunOptions): AsyncGenerator<AgentEvent> {
  const runId = `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  opts.onRunId?.(runId);
  const replace = (next?: ChatMessage[]) => {
    if (!Array.isArray(next)) return;
    // The daemon's transcript does not carry the host's per-turn stats; keep
    // any already attached to a message it sends back.
    const stats = new Map(opts.history.filter((m) => m.turnStats).map((m) => [m.id, m.turnStats!]));
    opts.history.splice(0, opts.history.length, ...next.map((m) => (!m.turnStats && stats.has(m.id) ? { ...m, turnStats: stats.get(m.id) } : m)));
  };
  // Events wait here with the resolver their sender is blocked on.
  const queue: Array<{ event: AgentEvent; consumed: () => void }> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  // End the run from this side: the daemon is gone or no longer knows it.
  const lost = (message: string) => {
    if (ended) return;
    queue.push({ event: { type: 'error', sessionId: opts.sessionId, message, relayOnly: false } as unknown as AgentEvent, consumed: () => {} });
    ended = true;
    notify();
  };
  runs.set(runId, {
    execute: opts.executeTool,
    approve: (call, reason, severity) => (opts.requestApproval ? opts.requestApproval(call, reason, severity) : Promise.resolve(false)),
    deliver: async (events, history) => {
      replace(history);
      const consumed = events.map(
        (event) => new Promise<void>((resolve) => queue.push({ event: { ...event, relayOnly: true } as unknown as AgentEvent, consumed: resolve })),
      );
      notify();
      await Promise.all(consumed);
    },
    end: (history) => {
      replace(history);
      ended = true;
      notify();
    },
  });
  // Stop asks the daemon to stop; a daemon that cannot be asked has already
  // lost the run, and the turn ends here instead of waiting on it.
  const onAbort = () =>
    void call('loop:abort', runId).catch(() => lost('Stopped'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let pendingAck: (() => void) | undefined;
  const interval = opts.livenessIntervalMs ?? LIVENESS_INTERVAL_MS;
  let canProbe: boolean | undefined;
  let strikes = 0;
  try {
    const spec = {
      runId,
      sessionId: opts.sessionId,
      provider: opts.provider,
      model: opts.model,
      system: opts.system,
      history: opts.history,
      tools: opts.tools,
      toolContext: opts.toolContext,
      temperature: opts.temperature,
      effort: opts.effort,
      think: opts.think,
      promptCaching: opts.promptCaching ?? true,
      maxHistoryTurns: opts.maxHistoryTurns,
      maxOutputTokens: opts.maxOutputTokens,
      resume: opts.resume,
    };
    // Do not discard older turns or images: the daemon needs the full history
    // for checkpoints, and the model's history window is applied separately.
    if (Buffer.byteLength(JSON.stringify({ args: [spec] })) > LOOP_RUN_BODY_LIMIT) {
      throw new Error('This reply exceeds the engine request limit (64 MiB). Reduce attached images or compact the conversation before retrying.');
    }
    await call('loop:run', spec);
    if (opts.signal?.aborted) onAbort();
    for (;;) {
      const item = queue.shift();
      if (item) {
        // Acknowledged when the consumer asks for the next one, which is after
        // it has handled this one (saved the checkpoint, sent it on).
        pendingAck?.();
        pendingAck = item.consumed;
        yield item.event;
        continue;
      }
      pendingAck?.();
      pendingAck = undefined;
      if (ended) break;
      // Wait for the next event, or for the liveness interval to pass with
      // nothing arriving (a long model call or tool is silent too, so silence
      // alone proves nothing: the daemon is asked).
      const woke = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), interval);
        wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      if (woke || ended || queue.length) continue;
      canProbe ??= await daemonOwns(call, LOOP_ALIVE);
      if (!canProbe) continue;
      try {
        const alive = await call<boolean>(LOOP_ALIVE, runId);
        strikes = 0;
        if (alive === false && !ended && !queue.length) lost('The engine stopped driving this reply. The steps it finished are saved.');
      } catch {
        if (++strikes >= LIVENESS_STRIKES && !ended && !queue.length) lost('The engine could not be reached. The steps it finished are saved.');
      }
    }
  } finally {
    pendingAck?.();
    for (const item of queue.splice(0)) item.consumed();
    runs.delete(runId);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
