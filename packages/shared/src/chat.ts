/** Chat / agent conversation types. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  /** Text or JSON-serializable output shown back to the model. */
  output: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Image data URLs attached to a user message. */
  images?: string[];
  /** Model chain-of-thought text, when the provider streams it. */
  reasoning?: string;
  /** Whole seconds spent streaming the reasoning text. */
  reasoningSeconds?: number;
  /** Skill invoked for this user turn and the user's own input. */
  skill?: { name: string; input: string };
  /** Tool calls requested by the assistant in this message. */
  toolCalls?: ToolCall[];
  /** Tool results (for role === 'tool'). */
  toolResult?: ToolResult;
  /**
   * This reply was cut off before it finished (the stream timed out, the network
   * dropped, or the user hit stop). What the model had produced is kept rather
   * than discarded, and the chat offers to resume from here.
   */
  interrupted?: boolean;
  createdAt: number;
}

/** Per-session Context Inspector preferences (which provenance items the user
 *  excluded or pinned), keyed by context item id. Persisted with the session. */
export interface ContextPrefs {
  excluded: string[];
  pinned: string[];
}

/**
 * How a chat handles tool execution:
 *  - `ask`, confirm every file write / command before it runs.
 *  - `guardrails`, run freely except where the guardrail rules say ask/deny.
 *  - `yolo`, run everything without confirming (deny rules still block).
 */
export type ChatMode = 'ask' | 'guardrails' | 'yolo';

export interface Session {
  id: string;
  title: string;
  workspaceId?: string;
  /** Additional context folders for this chat; workspaceId remains primary. */
  supportingWorkspaceIds?: string[];
  /**
   * When set, this session was spawned as a sub-agent by another session. The
   * workbench nests it as a sub-tab under its parent; the agent loop reports its
   * final answer back to the parent's `spawn_agent` tool call.
   */
  parentSessionId?: string;
  /** When set, this chat is driven by an automation task (shown in the Tasks
   *  board, kept out of the regular chat boards/lanes). */
  taskId?: string;
  /** When set, this chat is driven by a training/goal run (shown in the
   *  Training/Goals tabs, kept out of the regular chat boards/lanes; the
   *  report_experiment tool becomes available to the agent). */
  trainingRunId?: string;
  providerId?: string;
  modelId?: string;
  messages: ChatMessage[];
  contextPrefs?: ContextPrefs;
  /** Files explicitly attached to this chat's context (absolute paths). */
  attachedPaths?: string[];
  /** When set, the chat keeps a spec.md in the workspace updated each turn. */
  specLinked?: boolean;
  /** Spec-driven methodology id for this chat (see SPEC_METHODOLOGIES). */
  specMethodology?: string;
  /** When set, the chat picks the best model per turn (model auto-mode). */
  autoModel?: boolean;
  /**
   * How hard Auto mode leans on capability for this chat: `cheap` always takes
   * the smallest capable model, `quality` always the strongest, `normal` (the
   * default) reads each prompt and picks between them.
   */
  autoQuality?: import('./model-select.js').AutoQuality;
  /** Tool-execution policy for this chat. */
  mode?: ChatMode;
  /**
   * Per-chat reasoning toggle for models that support it: `true` forces thinking
   * on, `false` suppresses it, `undefined` leaves the model's default. Only
   * offered in the UI when the selected model is reasoning-capable.
   */
  thinking?: boolean;
  /** Tool names the user disabled for this chat (subset of the builtins). */
  disabledTools?: string[];
  /** Offline: no tool calls, no connectors/internet (local models only). */
  offline?: boolean;
  /** Incognito: don't persist the transcript or touch memory. */
  incognito?: boolean;
  /** Pinned to the top of the chat list. */
  pinned?: boolean;
  /** Free-form tags for organizing/filtering chats. */
  tags?: string[];
  /** Queued prompts to run one after another when the current turn finishes. */
  queue?: string[];
  /**
   * The plan for the prompt this chat is working on: decoded from the prompt,
   * then whatever the user edited it into. Lives on the session so the rail
   * survives a tab switch, and so a chat resumed tomorrow still shows what it
   * was told to do.
   */
  plan?: import('./prompt-plan.js').PromptPlan;
  /** Manual sidebar position within its project (set by drag-to-reorder). */
  order?: number;
  createdAt: number;
  updatedAt: number;
}

/** Return the primary and supporting context folders in stable, de-duplicated order. */
export function getSessionWorkspaceIds(
  session: Pick<Session, 'workspaceId' | 'supportingWorkspaceIds'>,
): string[] {
  return Array.from(new Set([
    ...(session.workspaceId ? [session.workspaceId] : []),
    ...(session.supportingWorkspaceIds ?? []).filter(Boolean),
  ]));
}

/** Time window for bulk chat deletion. */
export type ChatClearScope = 'today' | 'month' | 'all';

/** Streaming events emitted by the agent loop. */
export type AgentEvent =
  | { type: 'text'; sessionId: string; delta: string }
  | { type: 'reasoning'; sessionId: string; delta: string }
  | { type: 'tool_call'; sessionId: string; call: ToolCall }
  | { type: 'tool_approval_required'; sessionId: string; call: ToolCall; reason: string; severity: 'low' | 'medium' | 'high' }
  | { type: 'tool_result'; sessionId: string; result: ToolResult }
  /** The agent stopped to ask before carrying on. See `ask.ts`. */
  | { type: 'question'; sessionId: string; request: import('./ask.js').AskRequest }
  /** The question was answered or dropped, so anything showing it can stop. */
  | { type: 'question_resolved'; sessionId: string; callId: string }
  | {
      type: 'usage';
      sessionId: string;
      inputTokens: number;
      outputTokens: number;
      /**
       * Milliseconds the model spent generating `outputTokens` (decode only, no
       * prompt processing and no time between responses). The chat's tok/s
       * readout divides by the sum of these rather than by the turn's wall clock,
       * which also covers tool runs and approval waits. Absent when the provider
       * gave us nothing to measure.
       */
      outputMs?: number;
    }
  | { type: 'done'; sessionId: string; messageId: string }
  | { type: 'error'; sessionId: string; message: string };

/**
 * What a session is waiting on a person for, right now.
 *
 * Kept in the host rather than in whichever component happened to see the
 * event: a question asked while you were on another screen is still a question,
 * and the board has to be able to ask "who needs me" without having watched
 * every session's event stream since it started.
 */
export interface PendingInput {
  sessionId: string;
  /** A tool call waiting on approve/deny. */
  approval?: {
    call: ToolCall;
    reason: string;
    severity: 'low' | 'medium' | 'high';
    requestedAt: number;
  };
  /** An `ask_user` call waiting on answers. */
  question?: import('./ask.js').AskRequest;
}

/**
 * Output tokens per second, measured over the time the model spent generating
 * them (the summed `outputMs` of a turn's usage events), not over how long the
 * user waited. A turn that generates 500 tokens in 10 seconds and then runs a
 * 40-second test suite ran at 50 tok/s, not 10.
 *
 * Returns 0 when there is nothing to divide, which the UI reads as "no rate to
 * show" rather than printing a zero.
 */
export function decodeRate(outputTokens: number, decodeMs: number): number {
  if (outputTokens <= 0 || decodeMs <= 0) return 0;
  return outputTokens / (decodeMs / 1000);
}

/**
 * Render a tokens/second rate. Local models routinely run in the single digits,
 * where rounding to a whole number hides the difference between 8.6 and 9.4, so
 * slow rates keep one decimal and fast ones stay tidy.
 */
export function formatRate(tokensPerSecond: number): string {
  return tokensPerSecond >= 10 ? String(Math.round(tokensPerSecond)) : tokensPerSecond.toFixed(1);
}

/**
 * Whether a run that stopped part-way has anything worth resuming: a completed
 * step, a tool result, or the head of a reply that was cut off. A run that broke
 * before the model said anything has nothing to carry on from, so the chat offers
 * to simply run it again instead of offering to continue from nothing.
 */
export function hasResumableProgress(history: ChatMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') return false; // reached this turn's prompt, nothing after it
    if (m.role === 'tool') return true;
    if (m.role === 'assistant' && (m.content.trim() || m.toolCalls?.length || m.reasoning?.trim())) return true;
  }
  return false;
}

export interface SendOptions {
  sessionId: string;
  providerId: string;
  modelId: string;
  text: string;
  /** Image data URLs attached to this user turn. */
  images?: string[];
  /** Skill invoked for this user turn and the user's own input. */
  skill?: { name: string; input: string };
  /** File paths the user explicitly attached as context. */
  attachedPaths?: string[];
  /** Re-answer the last user turn: drop trailing assistant/tool messages and
   *  don't append a new user message. */
  regenerate?: boolean;
  /**
   * Carry on from a run that stopped part-way instead of starting it again.
   * Nothing is appended to the transcript and nothing is dropped from it: the
   * agent picks up after the last thing that completed, so the steps already
   * taken (and the tool results they produced) are not repeated. `text` is
   * ignored. See `regenerate` for the destructive alternative.
   */
  resume?: boolean;
  /**
   * Only send the last N user-turn groups to the model (the full transcript is
   * still persisted). Used by long-running run-driven turns (Goals/Training) so
   * a loop that spans hundreds of turns doesn't replay its whole ever-growing
   * history to the model each turn. Omitted for normal chats (full history).
   */
  maxHistoryTurns?: number;
}
