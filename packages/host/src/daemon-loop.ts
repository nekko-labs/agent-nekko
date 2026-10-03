import { randomBytes } from 'crypto';
import { appendAgentTerminal } from './terminal.js';
import type { AgentEvent, ChatMessage, EffortLevel, ProviderConfig, ToolCall, ToolResult } from '@agent-nekko/shared';

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
 */

type Call = <T>(channel: string, ...args: unknown[]) => Promise<T>;
type Severity = 'low' | 'medium' | 'high';

interface Run {
  execute: (call: ToolCall) => Promise<ToolResult>;
  approve: (call: ToolCall, reason: string, severity: Severity) => Promise<boolean>;
  deliver: (events: AgentEvent[], history?: ChatMessage[]) => Promise<void>;
  end: (history?: ChatMessage[]) => void;
}

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

/** `loop:event`: events (and, at a checkpoint, the transcript) from a daemon-driven run. */
export async function loopEvent(runId: string, payload: { events?: AgentEvent[]; history?: ChatMessage[] }): Promise<void> {
  await runs.get(runId)?.deliver(payload?.events ?? [], payload?.history);
}

/** `loop:end`: the run is over; this is its final transcript. */
export function loopEnd(runId: string, payload: { history?: ChatMessage[] }): void {
  runs.get(runId)?.end(payload?.history);
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
  maxHistoryTurns?: number;
  maxOutputTokens?: number;
  resume?: boolean;
}

export async function* runAgentViaDaemon(call: Call, opts: DaemonRunOptions): AsyncGenerator<AgentEvent> {
  const runId = `run_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  const replace = (next?: ChatMessage[]) => {
    if (Array.isArray(next)) opts.history.splice(0, opts.history.length, ...next);
  };
  // Events wait here with the resolver their sender is blocked on.
  const queue: Array<{ event: AgentEvent; consumed: () => void }> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const notify = () => {
    wake?.();
    wake = undefined;
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
  const onAbort = () => void call('loop:abort', runId).catch(() => {});
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let pendingAck: (() => void) | undefined;
  try {
    await call('loop:run', {
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
      maxHistoryTurns: opts.maxHistoryTurns,
      maxOutputTokens: opts.maxOutputTokens,
      resume: opts.resume,
    });
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
      await new Promise<void>((resolve) => (wake = resolve));
    }
  } finally {
    pendingAck?.();
    for (const item of queue.splice(0)) item.consumed();
    runs.delete(runId);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
