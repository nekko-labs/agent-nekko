import type { AgentEvent, ChatMessage, ToolCall, ToolResult } from '@agent-nekko/shared';
import { DEFAULT_MAX_STEPS } from '@agent-nekko/shared';
import type { Provider, ToolSpec } from '../providers/types.js';
import { BUILTIN_TOOLS } from './tools.js';
import { RUNAWAY_NOTE, createRunawayGuard } from './runaway.js';
import { INTERRUPTED_NOTE, RESUME_PROMPT, repairInterruptedHistory } from './resume.js';

export interface RunAgentOptions {
  sessionId: string;
  provider: Provider;
  model: string;
  system: string;
  /** Conversation so far (excluding system). New messages are appended in place. */
  history: ChatMessage[];
  tools?: ToolSpec[];
  /** Executes a tool call in the host and returns its result. */
  executeTool: (call: ToolCall) => Promise<ToolResult>;
  signal?: AbortSignal;
  /** Max tool-use round trips before wrapping up (see DEFAULT_MAX_STEPS). */
  maxIterations?: number;
  /** Sampling temperature (from the effort setting). */
  temperature?: number;
  /** Reasoning toggle passed to the provider (true/false/undefined = default). */
  think?: boolean;
  /**
   * When set, only the last N user-turn groups of `history` are sent to the
   * model (new messages are still appended to the full `history` array so the
   * caller persists the whole transcript). Cutting on user-message boundaries
   * keeps tool_use/tool_result pairs intact. Used by long-running run-driven
   * loops so they don't replay an ever-growing transcript every turn.
   */
  maxHistoryTurns?: number;
  /** Hard cap on tokens one provider response may generate (see MAX_OUTPUT_TOKENS_DEFAULT). */
  maxOutputTokens?: number;
  /**
   * Continue a run that stopped part-way rather than starting the turn over.
   * `history` is repaired first (see resume.ts) and the model is told to build on
   * what is already there, so the steps it already took are not repeated.
   */
  resume?: boolean;
  /** Pass response headers up to the host (rate-limit capture). */
  onHeaders?: (headers: Headers) => void;
}

let counter = 0;
function id(prefix: string): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

/**
 * Window `history` to the last `turns` user-turn groups for sending to the
 * model. Cuts on a user-message boundary so the window always starts on a user
 * message and never splits a tool_use from its tool_result. Returns `history`
 * unchanged when `turns` is falsy or there are no more than `turns` user
 * messages, so normal chats (no limit) are unaffected.
 */
export function windowHistory(history: ChatMessage[], turns?: number): ChatMessage[] {
  if (!turns || turns < 1) return history;
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  if (userIdx.length <= turns) return history;
  return history.slice(userIdx[userIdx.length - turns]);
}

/**
 * The agentic loop: stream a model response, run any tool calls, feed the
 * results back, and repeat until the model stops calling tools. Yields
 * normalized AgentEvents that the host forwards to the renderer.
 *
 * History is mutated to include the assistant + tool messages so callers can
 * persist the full transcript.
 */
/** What one streamed provider response accumulated. */
interface Turn {
  text: string;
  reasoning: string;
  reasoningSeconds?: number;
  calls: ToolCall[];
  /** Set when the stream was cut off for degenerate repetition (see runaway.ts). */
  runaway?: boolean;
}

/**
 * How much of a degenerate stream is kept in the transcript. The head is the
 * part worth keeping (the model usually reasons well, then collapses), so we
 * keep that and drop the cycle rather than persisting tens of thousands of
 * characters of the same sentence.
 */
const RUNAWAY_KEEP_CHARS = 4_000;

function trimRunaway(s: string): string {
  return s.length <= RUNAWAY_KEEP_CHARS
    ? s
    : `${s.slice(0, RUNAWAY_KEEP_CHARS)}\n\n[…cut off here: the model started repeating itself.]`;
}

/** A response that produced no text, no reasoning, and no tool calls. Some local
 *  models occasionally stop cold mid-agent-loop (finish_reason "stop" with a
 *  single token); treating that as a completed turn makes the chat look like it
 *  silently died. We detect it so the loop can retry once with a nudge. */
function isEmptyTurn(t: Turn): boolean {
  return !t.text.trim() && !t.reasoning.trim() && t.calls.length === 0;
}

/** Nudge for the wrap-up pass once the step budget is spent. */
const WRAP_UP_PROMPT =
  'You have reached this reply\'s tool-step limit, so no further tool calls are possible. ' +
  'Answer now with what you already know: what you did, what you found, and the concrete next steps you would take. ' +
  'Do not ask to run more tools.';

export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const tools = opts.tools ?? BUILTIN_TOOLS;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_STEPS;

  // Stream one provider response, yielding its events and accumulating the
  // result into `turn`. `extraMessages` are appended to the sent history only
  // (never persisted) so a retry can nudge the model without polluting the
  // transcript. `sendTools` overrides the offered tools (the wrap-up pass
  // withholds them entirely).
  async function* stream(turn: Turn, extraMessages: ChatMessage[] = [], sendTools = tools): AsyncGenerator<AgentEvent> {
    let reasoningStartedAt = 0;
    // Text and reasoning are watched separately: a model can collapse into a
    // loop in either channel, and a repeat in one says nothing about the other.
    const textGuard = createRunawayGuard();
    const reasoningGuard = createRunawayGuard();
    // Our own controller so tripping the guard actually closes the connection
    // instead of leaving the server streaming into a dropped iterator.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ctl.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      for await (const chunk of opts.provider.chat({
        model: opts.model,
        messages: [...windowHistory(opts.history, opts.maxHistoryTurns), ...extraMessages],
        system: opts.system,
        tools: sendTools,
        temperature: opts.temperature,
        think: opts.think,
        maxOutputTokens: opts.maxOutputTokens,
        signal: ctl.signal,
        onHeaders: opts.onHeaders,
      })) {
        switch (chunk.type) {
          case 'text':
            if (reasoningStartedAt && turn.reasoningSeconds == null) {
              turn.reasoningSeconds = Math.round((Date.now() - reasoningStartedAt) / 1000);
            }
            turn.text += chunk.delta;
            yield { type: 'text', sessionId: opts.sessionId, delta: chunk.delta };
            if (textGuard.push(chunk.delta)) turn.runaway = true;
            break;
          case 'reasoning':
            if (!reasoningStartedAt) reasoningStartedAt = Date.now();
            turn.reasoning += chunk.delta;
            yield { type: 'reasoning', sessionId: opts.sessionId, delta: chunk.delta };
            if (reasoningGuard.push(chunk.delta)) turn.runaway = true;
            break;
          case 'tool_call':
            if (reasoningStartedAt && turn.reasoningSeconds == null) {
              turn.reasoningSeconds = Math.round((Date.now() - reasoningStartedAt) / 1000);
            }
            turn.calls.push(chunk.call);
            yield { type: 'tool_call', sessionId: opts.sessionId, call: chunk.call };
            break;
          case 'usage':
            yield {
              type: 'usage',
              sessionId: opts.sessionId,
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              outputMs: chunk.outputMs,
            };
            break;
          case 'done':
            break;
        }
        // Cut a degenerate stream off here rather than waiting out the output
        // cap: it has stopped making progress and will not recover.
        if (turn.runaway) {
          ctl.abort();
          break;
        }
      }
    } catch (e) {
      // Our own abort surfaces as an AbortError; that isn't a failure to report.
      if (!turn.runaway) throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
    if (reasoningStartedAt && turn.reasoningSeconds == null) {
      turn.reasoningSeconds = Math.round((Date.now() - reasoningStartedAt) / 1000);
    }
  }

  /**
   * End a reply whose stream broke. Whatever the model produced up to that point
   * is kept in the transcript (dropping it is what made a timeout on a long reply
   * feel like the whole run was thrown away); any tool call it was part-way
   * through emitting is not, because the arguments may be truncated and it never
   * ran. The host has already checkpointed the steps before this one.
   */
  function* endInterrupted(turn: Turn, error: unknown): Generator<AgentEvent> {
    const partial = (turn.runaway ? trimRunaway(turn.text) : turn.text).trim();
    const reasoning = turn.reasoning.trim();
    if (partial || reasoning) {
      opts.history.push({
        id: id('msg'),
        role: 'assistant',
        content: [partial, INTERRUPTED_NOTE].filter(Boolean).join('\n\n'),
        ...(reasoning ? { reasoning, reasoningSeconds: turn.reasoningSeconds } : {}),
        interrupted: true,
        createdAt: Date.now(),
      });
    }
    yield {
      type: 'error',
      sessionId: opts.sessionId,
      // A stop the user asked for is not a failure, and shouldn't read as one.
      message: opts.signal?.aborted ? 'Stopped' : (error as Error).message,
    };
  }

  // Resuming: make the interrupted transcript valid to send again, then give the
  // model one transient turn to push against when the last thing in it is its own
  // cut-off reply (a transcript ending on a tool result already has its opening).
  let resumeExtra: ChatMessage[] = [];
  if (opts.resume) {
    repairInterruptedHistory(opts.history);
    if (opts.history[opts.history.length - 1]?.role === 'assistant') {
      resumeExtra = [{ id: id('nudge'), role: 'user', content: RESUME_PROMPT, createdAt: Date.now() }];
    }
  }

  // A transient nudge used to recover from an empty response (not persisted).
  const nudge: ChatMessage = {
    id: id('nudge'),
    role: 'user',
    content: 'Please continue and give your answer.',
    createdAt: Date.now(),
  };

  for (let iter = 0; iter < maxIterations; iter++) {
    if (opts.signal?.aborted) {
      yield { type: 'error', sessionId: opts.sessionId, message: 'Aborted' };
      return;
    }

    const turn: Turn = { text: '', reasoning: '', calls: [] };
    try {
      yield* stream(turn, iter === 0 ? resumeExtra : []);
      // Empty response: retry once with a nudge before giving up so the turn
      // doesn't silently stall (common with some local models mid-loop).
      if (isEmptyTurn(turn) && !opts.signal?.aborted) {
        yield* stream(turn, [nudge]);
      }
    } catch (e) {
      yield* endInterrupted(turn, e);
      return;
    }

    const { text, reasoning, reasoningSeconds, calls } = turn;

    // Still nothing after the retry: surface it instead of ending on a blank
    // bubble, so the user knows the turn ended and can try again.
    const stalled = isEmptyTurn(turn);
    const content = stalled
      ? '_The model returned an empty response and stopped. It may have run out of steam — try again, or rephrase._'
      : text;

    // Record the assistant message. A stream we cut off for looping keeps its
    // useful head, is annotated with why it stopped, and drops any tool call it
    // was mid-way through emitting (the arguments are not trustworthy).
    const assistantMsg: ChatMessage = turn.runaway
      ? {
          id: id('msg'),
          role: 'assistant',
          content: [trimRunaway(text).trim(), RUNAWAY_NOTE].filter(Boolean).join('\n\n'),
          ...(reasoning ? { reasoning: trimRunaway(reasoning), reasoningSeconds } : {}),
          createdAt: Date.now(),
        }
      : {
          id: id('msg'),
          role: 'assistant',
          content,
          ...(reasoning ? { reasoning, reasoningSeconds } : {}),
          toolCalls: calls.length ? calls : undefined,
          createdAt: Date.now(),
        };
    opts.history.push(assistantMsg);

    // A looping model does not recover by being asked again, so end the reply
    // here instead of spending the rest of the step budget on the same cycle.
    if (turn.runaway) {
      yield { type: 'done', sessionId: opts.sessionId, messageId: assistantMsg.id };
      return;
    }

    // No tool calls → the turn is complete.
    if (calls.length === 0) {
      yield { type: 'done', sessionId: opts.sessionId, messageId: assistantMsg.id };
      return;
    }

    // Execute tool calls sequentially (the host applies guardrails/approval).
    for (const call of calls) {
      let result: ToolResult;
      try {
        result = await opts.executeTool(call);
      } catch (e) {
        result = { toolCallId: call.id, output: `Error: ${(e as Error).message}`, isError: true };
      }
      opts.history.push({
        id: id('msg'),
        role: 'tool',
        content: '',
        toolResult: result,
        createdAt: Date.now(),
      });
      yield { type: 'tool_result', sessionId: opts.sessionId, result };
    }
  }

  // Budget spent. Instead of discarding everything the model just did (which is
  // what surfacing an error here used to do), take one last pass with the tools
  // withheld so the work comes back as a real answer the user can act on.
  if (opts.signal?.aborted) {
    yield { type: 'error', sessionId: opts.sessionId, message: 'Aborted' };
    return;
  }
  const wrapUp: Turn = { text: '', reasoning: '', calls: [] };
  try {
    yield* stream(
      wrapUp,
      [{ id: id('nudge'), role: 'user', content: WRAP_UP_PROMPT, createdAt: Date.now() }],
      [],
    );
  } catch (e) {
    yield* endInterrupted(wrapUp, e);
    return;
  }

  const note = wrapUp.runaway
    ? RUNAWAY_NOTE
    : `_Stopped at this reply's ${maxIterations}-step tool limit. Ask me to continue and I'll pick up from here (or raise the limit in Settings → Agent loop)._`;
  const wrapText = (wrapUp.runaway ? trimRunaway(wrapUp.text) : wrapUp.text).trim();
  const wrapMsg: ChatMessage = {
    id: id('msg'),
    role: 'assistant',
    content: wrapText ? `${wrapText}\n\n${note}` : note,
    ...(wrapUp.reasoning
      ? {
          reasoning: wrapUp.runaway ? trimRunaway(wrapUp.reasoning) : wrapUp.reasoning,
          reasoningSeconds: wrapUp.reasoningSeconds,
        }
      : {}),
    createdAt: Date.now(),
  };
  opts.history.push(wrapMsg);
  yield { type: 'done', sessionId: opts.sessionId, messageId: wrapMsg.id };
}
