import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentEvent, AskAnswer, ChatMessage, ContextBundle, PendingInput, ProviderConfig, QueuedPrompt, ReplySuggestions, SendOptions, Session, ToolCall, ToolResult } from '@agent-nekko/shared';
import { ASK_CANCELLED, ASK_UNATTENDED, EFFORT_TEMPERATURE, applyPlanUpdate, effectiveEffort, guessContextWindow, DEFAULT_ORCHESTRATION, clampMaxOutputTokens, formatAskAnswers, getSessionWorkspaceIds, getStrategy, isChatModel, isLocalProvider, sinceCompaction, orchestrationPromptHint, parseAskRequest, parseReplySuggestions, planEcho, queueItemPayload } from '@agent-nekko/shared';
import {
  createProvider,
  runAgent,
  buildSystemPrompt,
  assembleContext,
  renderContextBlock,
  isGuidelineFile,
  getConnector,
  ASK_USER_TOOL,
  BUILTIN_TOOLS,
  DECIDE_TOOL,
  decideRequestFromTool,
  REPORT_EXPERIMENT_TOOL,
  REPORT_ARTIFACT_TOOL,
  UPDATE_PLAN_TOOL,
  repairInterruptedHistory,
  INTERRUPTED_NOTE,
} from '@agent-nekko/core';
import { reportExperiment, reportArtifact, updateRunPlan, runPlanForSession } from './training.js';
import { getSettings } from './store.js';
import { DEFAULT_TURN_WRAPPER } from '@agent-nekko/shared';
import { chatWorkspaces, prepareChatWorktrees, runWorktreeSetup } from './chat-worktrees.js';

/**
 * Where the `decide` tool sends its questions. Set by the host once the
 * engine exists; `available` names the provider a turn would use (a loaded
 * Laya first, then TypeSafe when a key is set), or null to leave the tool out.
 */
interface DecisionRunner {
  available(): Promise<import('@agent-nekko/shared').DecisionProvider | null>;
  run(provider: import('@agent-nekko/shared').DecisionProvider, request: import('@agent-nekko/shared').DecisionRequest): Promise<import('@agent-nekko/shared').DecisionResponse>;
}
let decisions: DecisionRunner | null = null;
export function setDecisionRunner(runner: DecisionRunner | null): void {
  decisions = runner;
}
import { getSession, listSessions, saveSession, saveTurnSession, createSession, setSessionOptions, queuePrompt } from './sessions.js';
import { executeTool } from './tools.js';
import { AGENT_WATCH_TOOL, agentWatchTool } from './agent-watches.js';
import { recordUsage } from './usage.js';
import { recordReply } from './replies.js';
import * as LimitsService from './limits.js';
import { listMemory } from './memory.js';
import { ensureFreshToken, resolveSubscriptionProvider } from './oauth.js';
import { searchWorkspace } from './workspace.js';
import { buildSpec } from './spec.js';
import { syncMcp, mcpToolSpecs, isMcpTool, callMcpTool } from './mcp.js';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns, daemonRunsLoops, runAgentViaDaemon } from './daemon-loop.js';
import { completeText } from './sideband.js';
import { appendAgentTerminal, finishAgentTerminal } from './terminal.js';

/**
 * Retrieve code snippets from the session's workspace index relevant to the
 * query, so the model gets grounding without having to grep first. Keyword
 * tokens are searched, hits grouped per file, and the top few files included.
 */
function collectIndexSnippets(
  workspaceIds: string[],
  query: string,
): Array<{ relPath: string; path: string; body: string }> {
  if (!workspaceIds.length || !query.trim()) return [];
  const tokens = Array.from(new Set(query.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [])).slice(0, 6);
  if (tokens.length === 0) return [];

  const byFile = new Map<string, { relPath: string; path: string; lines: string[]; workspaceRank: number }>();
  for (const [workspaceRank, workspaceId] of workspaceIds.entries()) {
    const folder = getSettings().workspaces.find((w) => w.id === workspaceId);
    if (!folder) continue;
    for (const token of tokens) {
      for (const hit of searchWorkspace(folder, token)) {
        const entry = byFile.get(hit.path) ?? { relPath: hit.relPath, path: hit.path, lines: [], workspaceRank };
        if (entry.lines.length < 8) entry.lines.push(`${hit.line}: ${hit.text}`);
        byFile.set(hit.path, entry);
      }
    }
  }

  return [...byFile.entries()]
    .sort((a, b) => a[1].workspaceRank - b[1].workspaceRank || b[1].lines.length - a[1].lines.length)
    .slice(0, 4)
    .map(([, v]) => ({ relPath: v.relPath, path: v.path, body: v.lines.join('\n') }));
}

type Sender = (event: AgentEvent) => void;

/** The built-in tools the engine daemon runs itself (crates/nekko-tools `PORTED_TOOLS`). */
const DAEMON_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_dir', 'bash']);

const abortControllers = new Map<string, AbortController>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const pendingAnswers = new Map<string, (answers: AskAnswer[]) => void>();
/** Messages sent to a running chat, waiting for its next tool boundary (TS-loop runs). */
const steering = new Map<string, ChatMessage[]>();
/** The daemon run id of each chat the daemon is driving, for `loop:steer`. */
const daemonRunIds = new Map<string, string>();

/**
 * What each session is waiting on a person for.
 *
 * The events already say so as they happen, but an event is only seen by
 * whatever was mounted at the time. The board needs to answer "who needs me"
 * on mount, after a view switch, and after a reload, so the question lives here
 * until it is answered.
 */
const pendingBySession = new Map<string, PendingInput>();

function setPending(sessionId: string, patch: Partial<Omit<PendingInput, 'sessionId'>>): void {
  const next: PendingInput = { ...(pendingBySession.get(sessionId) ?? { sessionId }), ...patch };
  if (!next.approval && !next.question) pendingBySession.delete(sessionId);
  else pendingBySession.set(sessionId, next);
}

/** Everything waiting on a person right now, keyed by session. */
export function getPendingInput(): Record<string, PendingInput> {
  return Object.fromEntries(pendingBySession);
}

function isAuthFailure(message: string): boolean {
  return /\b401\b|unauthorized|invalid auth|invalid api key|authentication/i.test(message);
}

/**
 * Apply an `update_plan` call to an ordinary chat's live plan (run sessions go
 * through updateRunPlan instead). Persisting and notifying are the caller's
 * job — the function returns the echo text either way.
 */
function updateSessionPlan(session: Session, input: Record<string, unknown>): string {
  const result = applyPlanUpdate(session.agentPlan, input);
  if ('error' in result) return result.error;
  session.agentPlan = result.plan;
  session.updatedAt = Date.now();
  return planEcho(result.plan);
}

/**
 * Write a real title once a chat's first turn has content. Uses the chat's own
 * provider and model; a failure just leaves the prompt-prefix placeholder.
 * `titleAuto` is the guard: it flips false the moment the user names the chat.
 */
async function titleSession(
  sessionId: string,
  provider: ProviderConfig,
  modelId: string,
  send: Sender,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.titleAuto !== true) return;
  const userText = session.messages.find((m) => m.role === 'user')?.content ?? '';
  if (!userText.trim()) return;
  const assistantText =
    [...session.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
  try {
    const out = await completeText(provider, {
      model: modelId,
      messages: [
        {
          id: 'title',
          role: 'user',
          createdAt: Date.now(),
          content:
            `Give this task a short title, 3 to 6 words, for a workspace card. ` +
            `Answer with only the title: no quotes, no trailing punctuation.\n\n` +
            `Request: ${userText.slice(0, 600)}` +
            (assistantText ? `\nWhat was done: ${assistantText.slice(0, 240)}` : ''),
        },
      ],
      temperature: 0.2,
      maxOutputTokens: 24,
      think: false,
      purpose: 'title',
    });
    const title = out
      .replace(/["'`]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?:;\-–—]+$/, '')
      .trim()
      .slice(0, 64);
    if (!title) return;
    const fresh = getSession(sessionId);
    // Re-check the flag: a rename while the call was in flight is the user's.
    if (!fresh || fresh.titleAuto !== true) return;
    fresh.title = title;
    // Written once: the flag stays the "may generate" gate, so landing a title
    // also ends generation; a rename to it later is just a rename.
    fresh.titleAuto = false;
    fresh.updatedAt = Date.now();
    saveSession(fresh);
    send({ type: 'session_meta', sessionId });
  } catch {
    /* a nicer title is nice-to-have; the prompt prefix stays */
  }
}

/**
 * Suggest what the user might send next: a few short follow-ups (the one-click
 * chips) plus the single most likely next message (the composer's ghost text).
 *
 * Same family as `titleSession`: a small sideband call on the provider and
 * model the reply itself ran on, tagged `purpose: 'suggest'` so it stays out of
 * turn accounting. It reads the persisted transcript, writes nothing, and a
 * model or network failure just means no suggestions rather than an error.
 */
export async function suggestReplies(sessionId: string): Promise<ReplySuggestions | null> {
  const session = getSession(sessionId);
  if (!session) return null;
  // Automation- and delegation-driven chats have nobody at the composer to
  // click a suggestion, so they never pay for the call.
  if (session.taskId || session.trainingRunId || session.parentSessionId) return null;
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== 'assistant' || !last.content.trim()) return null;
  const settings = getSettings();
  const providerId = session.providerId ?? settings.defaultProviderId;
  const modelId = session.modelId ?? settings.defaultModelId;
  const provider = providerId ? settings.providers.find((p) => p.id === providerId) : undefined;
  if (!provider?.enabled || !modelId) return null;
  if (session.offline && !offlineProviderAllowed(provider)) return null;
  if (!providerEndpoint(provider)) return null;

  // The tail of the conversation, each message clipped: enough to suggest from,
  // cheap enough for a small local model to read.
  const tail = session.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-6)
    .map((m) => {
      const tools =
        m.role === 'assistant' && m.toolCalls?.length
          ? ` [used tools: ${Array.from(new Set(m.toolCalls.map((c) => c.name))).join(', ')}]`
          : '';
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 800).trim()}${tools}`;
    })
    .join('\n\n');

  try {
    const resolved = await resolveSubscriptionProvider(provider);
    const out = await completeText(resolved, {
      model: modelId,
      messages: [
        {
          id: 'suggest',
          role: 'user',
          createdAt: Date.now(),
          content:
            `You are suggesting the user's next message in a chat with an AI assistant that can answer questions and work on their computer (read files, run commands, edit code).\n` +
            `From the conversation, propose 2 to 4 short follow-up messages the user is most likely to send next, each under 10 words, written as the user would write them, specific to what the assistant just did or said.\n` +
            `Then give "next": the single most likely next message in full, under 30 words.\n` +
            `Reply with one JSON object and nothing else: {"options":["...","..."],"next":"..."}\n\n` +
            `Conversation:\n${tail}`,
        },
      ],
      temperature: 0.4,
      maxOutputTokens: 220,
      think: false,
      purpose: 'suggest',
    });
    return parseReplySuggestions(out);
  } catch {
    return null;
  }
}

/**
 * Draft one missing piece of a prompt the user is composing: the analyzer's
 * click-to-fill chips used to insert fixed starter snippets matched by text
 * rules; this asks the model to write the snippet from the prompt itself
 * instead, so a "Role" chip on a code review prompt gets a code-reviewer
 * persona, not the generic senior-engineer line.
 *
 * Same sideband family as `suggestReplies`: small call on the session's own
 * provider and model, tagged `purpose: 'fill'`, writes nothing, and any
 * failure returns null so the caller falls back to the deterministic snippet.
 */
export async function fillPromptPart(sessionId: string, part: string, draft: string): Promise<string | null> {
  const session = getSession(sessionId);
  if (!session) return null;
  const settings = getSettings();
  const providerId = session.providerId ?? settings.defaultProviderId;
  const modelId = session.modelId ?? settings.defaultModelId;
  const provider = providerId ? settings.providers.find((p) => p.id === providerId) : undefined;
  if (!provider?.enabled || !modelId) return null;
  if (session.offline && !offlineProviderAllowed(provider)) return null;
  if (!providerEndpoint(provider)) return null;

  try {
    const resolved = await resolveSubscriptionProvider(provider);
    const out = await completeText(resolved, {
      model: modelId,
      messages: [
        {
          id: 'fill',
          role: 'user',
          createdAt: Date.now(),
          content:
            `The user is composing this prompt for an AI assistant:\n` +
            `"""\n${draft.slice(0, 2_000).trim()}\n"""\n\n` +
            `The prompt is missing a "${part}" part. Write one short snippet they could add to cover it, matched to their topic and voice: at most two sentences or a few short lines. ` +
            `Return only the snippet text; no preamble, no quotes, no labels.`,
        },
      ],
      temperature: 0.4,
      maxOutputTokens: 120,
      think: false,
      purpose: 'fill',
    });
    const cleaned = out
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim()
      .slice(0, 320);
    return cleaned || null;
  } catch {
    return null;
  }
}

/** Resolve a pending tool approval (called from IPC when the user clicks). */
export function resolveApproval(sessionId: string, toolCallId: string, approved: boolean): void {
  pendingApprovals.get(toolCallId)?.(approved);
  pendingApprovals.delete(toolCallId);
  const current = pendingBySession.get(sessionId);
  if (current?.approval?.call.id === toolCallId) setPending(sessionId, { approval: undefined });
}

/**
 * Answer an `ask_user` call. An empty answer list is a deliberate "I'm not
 * answering": the agent is told to choose and carry on rather than left parked
 * on a promise nobody will ever settle.
 */
export function resolveQuestion(sessionId: string, callId: string, answers: AskAnswer[]): void {
  const resolve = pendingAnswers.get(callId);
  pendingAnswers.delete(callId);
  const current = pendingBySession.get(sessionId);
  if (current?.question?.callId === callId) setPending(sessionId, { question: undefined });
  resolve?.(answers);
}

/**
 * Let go of anything this session is blocking on. A stopped run must not leave
 * the loop awaiting an approval or an answer that can no longer arrive: the
 * turn would sit there, un-abortable, until the app was restarted.
 */
function releasePending(sessionId: string): void {
  const pending = pendingBySession.get(sessionId);
  if (pending?.approval) {
    pendingApprovals.get(pending.approval.call.id)?.(false);
    pendingApprovals.delete(pending.approval.call.id);
  }
  if (pending?.question) {
    pendingAnswers.get(pending.question.callId)?.([]);
    pendingAnswers.delete(pending.question.callId);
  }
  pendingBySession.delete(sessionId);
}

/**
 * Chats a previous host left mid-turn (a crash, a quit, a kill): their record
 * still carries `activeRun`. Nothing is running them now, so say so in the
 * transcript (an `interrupted` reply, which is what makes the chat offer
 * Continue) and clear the marker. Called once, when the host starts; returns
 * how many chats were marked.
 */
export function reconcileInterruptedChats(): number {
  let marked = 0;
  for (const session of listSessions()) {
    if (!session.activeRun) continue;
    const last = session.messages[session.messages.length - 1];
    const alreadyMarked = last?.role === 'assistant' && last.interrupted;
    if (last && last.role !== 'user' && !alreadyMarked) {
      session.messages.push({
        id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        content: `_The app closed while this reply was running._

${INTERRUPTED_NOTE}`,
        interrupted: true,
        createdAt: Date.now(),
      });
    }
    delete session.activeRun;
    saveSession(session);
    marked++;
  }
  return marked;
}

/**
 * Steer a running reply: the text becomes a user message at the chat's next
 * tool boundary (never mid-stream), so the model sees it without the turn
 * being stopped and started over, as pi's steering queue and typing into a
 * working Claude Code session do. A daemon-driven run gets it through
 * `loop:steer`; a chat that is not running (or a daemon too old to take it)
 * gets the text queued for after the turn instead.
 */
export async function steerChat(sessionId: string, text: string): Promise<Session | null> {
  const content = text.trim();
  if (!content) return getSession(sessionId);
  if (!isChatRunning(sessionId)) return queuePrompt(sessionId, content);
  const message: ChatMessage = { id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, role: 'user', content, createdAt: Date.now() };
  const runId = daemonRunIds.get(sessionId);
  const daemon = runId ? daemonCall() : undefined;
  if (runId && daemon && (await daemonOwns(daemon, 'loop:steer'))) {
    const taken = await daemon<boolean>('loop:steer', runId, message).catch(() => false);
    if (taken) return getSession(sessionId);
    if (!isChatRunning(sessionId)) return queuePrompt(sessionId, content);
  }
  const inbox = steering.get(sessionId) ?? [];
  inbox.push(message);
  steering.set(sessionId, inbox);
  return getSession(sessionId);
}

export function abortChat(sessionId: string): void {
  abortControllers.get(sessionId)?.abort();
  abortControllers.delete(sessionId);
  releasePending(sessionId);
}

export function isChatRunning(sessionId: string): boolean {
  return abortControllers.has(sessionId);
}

/** Read guideline files (AGENTS.md/CLAUDE.md/...) from the workspace roots. */
export function collectGuidelines(
  workspaces: Array<{ path: string }> = getSettings().workspaces,
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const names = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', 'GEMINI.md'];
  for (const w of workspaces) {
    const found: Array<{ path: string; name: string; content: string }> = [];
    for (const n of names) {
      if (!isGuidelineFile(n)) continue;
      const p = join(w.path, n);
      if (!existsSync(p)) continue;
      try {
        found.push({ path: p, name: n, content: readFileSync(p, 'utf8').slice(0, 20000) });
      } catch {
        /* skip */
      }
    }
    for (const f of found) {
      // A file that only redirects to another guideline in the same folder is
      // not guidance, it is a signpost for whichever tool reads that name.
      // `CLAUDE.md` saying "see AGENTS.md" is the common arrangement, and
      // loading it put the same instructions in the window twice and drew two
      // Guidelines sections in the inspector.
      if (found.length > 1 && isPointerTo(f, found)) continue;
      // A verbatim copy of a guideline already taken is the other way the same
      // duplication happens: the file is real, but its content is not new.
      if (out.some((o) => o.content.trim() === f.content.trim())) continue;
      out.push({ path: f.path, content: f.content });
    }
  }
  return out;
}

/**
 * Whether a guideline file is just a pointer at one of its siblings.
 *
 * Short, and naming another guideline that is actually present beside it. Both
 * halves matter: length alone would drop a genuinely terse `.cursorrules`, and
 * a mention alone would drop a long document that merely cites `AGENTS.md`.
 */
export function isPointerTo(
  file: { name: string; content: string },
  siblings: Array<{ name: string }>,
): boolean {
  const body = file.content.trim();
  if (body.length > 600) return false;
  return siblings.some((s) => s.name !== file.name && body.includes(s.name));
}

export function collectAttached(paths: string[]): Array<{ path: string; content: string }> {
  return paths
    .map((p) => {
      try {
        return existsSync(p) ? { path: p, content: readFileSync(p, 'utf8').slice(0, 20000) } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; content: string } => !!x);
}

/**
 * Best-effort fetch of a few resources from each connected connector, mapped to
 * context snippets. Bounded by an overall timeout so a slow/unreachable service
 * never stalls a turn; failures are silently skipped.
 */
async function collectConnectorSnippets(
  query?: string,
  timeoutMs = 2500,
): Promise<Array<{ label: string; origin: string; body: string }>> {
  const connectors = getSettings().connectors.filter((c) => c.connected && c.token);
  if (connectors.length === 0) return [];

  const fetches = connectors.map(async (c) => {
    try {
      const resources = await getConnector(c.kind).fetch(c.token!, query, c.settings);
      return resources.slice(0, 5).map((r) => ({
        label: r.title,
        origin: c.kind,
        body: [r.subtitle, r.body].filter(Boolean).join(', ') || r.title,
      }));
    } catch {
      return [];
    }
  });

  const timeout = new Promise<never[]>((resolve) => setTimeout(() => resolve([]), timeoutMs));
  const settled = await Promise.race([Promise.all(fetches), timeout]);
  return Array.isArray(settled) ? settled.flat() : [];
}

/** Context window for the headroom bar, from the model id (see guessContextWindow). */
const modelContextWindow = guessContextWindow;

/** Build the context bundle for the Context Inspector preview (no model call). */
export async function previewContext(sessionId: string, attachedPaths: string[]): Promise<ContextBundle> {
  const session = getSession(sessionId);
  const settings = getSettings();
  // The base system prompt (no per-turn context block — those items are counted
  // individually below) so the inspector reflects true window usage.
  const systemText = buildSystemPrompt({
    workspaces: chatWorkspaces(session, settings),
    systemInstructions: settings.systemInstructions,
    turnWrapper: settings.turnWrapper ?? DEFAULT_TURN_WRAPPER,
    aboutUser: settings.aboutUser,
    contextBlock: '',
    platform: process.platform,
  });
  const { contents: _contents, ...preview } = assembleContext({
    attached: collectAttached([...(session?.attachedPaths ?? []), ...attachedPaths]),
    guidelines: collectGuidelines(chatWorkspaces(session, settings)),
    memory: [
      ...listMemory('global'),
      ...((session ? getSessionWorkspaceIds(session) : []).flatMap((id) => listMemory('workspace', id))),
    ],
    connectorSnippets: !session || session.offline ? [] : await collectConnectorSnippets(),
    indexSnippets: [],
    // The whole message, not just its text: reasoning and tool traffic are
    // replayed to the model too, and on a long run they are most of the window.
    history: sinceCompaction(session?.messages ?? []),
    systemText,
    contextWindow: modelContextWindow(session?.modelId),
    excluded: new Set(session?.contextPrefs?.excluded ?? []),
    pinned: new Set(session?.contextPrefs?.pinned ?? []),
  });
  // The inspector draws previews; the full text of every attached file stays
  // host-side rather than crossing IPC on every refresh.
  return preview;
}

/** Persist the user's include/pin choices for a session. */
export function setContextPrefs(sessionId: string, prefs: { excluded: string[]; pinned: string[] }): void {
  const session = getSession(sessionId);
  if (!session) return;
  session.contextPrefs = prefs;
  saveSession(session);
}

/** How deep in the sub-agent tree a session sits (root = 0). */
function sessionDepth(sessionId: string): number {
  let depth = 0;
  let cur = getSession(sessionId);
  while (cur?.parentSessionId && depth < 16) {
    depth++;
    cur = getSession(cur.parentSessionId);
  }
  return depth;
}

function providerEndpoint(provider: ProviderConfig): URL | null {
  if (!isLocalProvider(provider.kind) && !['anthropic', 'openai', 'openrouter', 'chatgpt', 'openai-compat'].includes(provider.kind)) return null;
  try {
    const url = new URL(provider.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

export function offlineProviderAllowed(provider: ProviderConfig): boolean {
  const url = providerEndpoint(provider);
  // openai-compat is dual-use rather than a local kind, so it is allowed by
  // name; the loopback check still decides whether this endpoint is local.
  return !!url && (isLocalProvider(provider.kind) || provider.kind === 'openai-compat') && (
    url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  );
}

function routingPrompt(providers: ProviderConfig[]): string {
  const secrets = providers.flatMap((p) => [p.apiKey, p.baseUrl]).filter((s): s is string => !!s);
  const safe = (value: string) => {
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value.replace(/https?:\/\/\S+/gi, '[redacted]');
  };
  const enabled = providers.filter((p) => p.enabled).map((p) => ({ id: safe(p.id), label: safe(p.label) }));
  return [
    'Sub-agent routing: enabled configured providers (IDs and labels only):',
    JSON.stringify(enabled),
    'Omit provider_id and model_id to inherit this chat\'s provider and model. An explicit provider change requires an explicit exact model ID for that provider.',
    'Only select a model ID already known for the target provider; never guess. If no exact model ID is known, ask the user to supply one before delegating to that provider. The target model list is checked only when explicit delegation is requested.',
    'There is no fallback to another provider or model on failure. Keep sensitive work on the intended provider; do not switch to a cloud provider to bypass a local failure. Incognito delegation is unavailable because child sessions are persisted.',
  ].join('\n');
}

/**
 * Run a delegated sub-task as a fresh child session and return its final answer.
 * The child streams its own agent events (under its own sessionId) so the
 * workbench can show it as a nested tab; we read back its last assistant message
 * as the tool result for the parent.
 */
async function runSubAgent(
  parent: Session,
  providerId: string,
  modelId: string,
  input: unknown,
  send: Sender,
  signal?: AbortSignal,
): Promise<string> {
  const parentId = parent.id;
  const settings = getSettings();
  const maxDepth = settings.orchestration?.maxDepth ?? DEFAULT_ORCHESTRATION.maxDepth;
  if (sessionDepth(parentId) >= maxDepth) {
    throw new Error('Sub-agent depth limit reached, handle this part of the task directly instead of delegating further.');
  }
  if (parent.incognito) throw new Error('Delegation is unavailable in incognito chats because child sessions are persisted. Handle this task in the current chat.');
  if (parent.offline) throw new Error('Offline chats cannot call tools, including sub-agents.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Sub-agent input must be an object.');
  const inp = input as Record<string, unknown>;
  const { task, title } = inp;
  if (typeof task !== 'string' || !task.trim()) throw new Error('A nonblank task is required for the sub-agent.');
  if (title !== undefined && typeof title !== 'string') throw new Error('Sub-agent title must be a string.');
  for (const key of ['provider_id', 'model_id']) {
    if (key in inp && (typeof inp[key] !== 'string' || !inp[key].trim() || inp[key] !== inp[key].trim())) {
      throw new Error(`${key} must be a nonblank exact ID without surrounding whitespace.`);
    }
  }
  const targetProviderId = (inp.provider_id as string | undefined) ?? providerId;
  const targetModelId = (inp.model_id as string | undefined) ?? modelId;
  if (targetProviderId !== providerId && !('model_id' in inp)) {
    throw new Error('Changing provider requires an explicit model_id known to belong to that provider. Ask the user for the exact model ID; never guess.');
  }
  if (!targetModelId?.trim()) throw new Error('A nonblank target model ID is required.');
  const provider = settings.providers.find((p) => p.id === targetProviderId);
  if (!provider?.enabled) throw new Error('Target provider is unknown or disabled.');
  if (!providerEndpoint(provider)) throw new Error('Target provider requires a valid HTTP(S) endpoint.');
  if ('model_id' in inp) {
    let models;
    try {
      const resolved = await resolveSubscriptionProvider(provider);
      models = await createProvider(resolved).listModels();
    } catch {
      throw new Error('Could not verify the target provider model list. Check its availability; no child was created and no fallback was used.');
    }
    const model = models.find((m) => m.id === targetModelId && m.providerId === targetProviderId);
    if (!model) throw new Error('The exact model ID is not available from the target provider. Ask the user for a known exact model ID; no fallback was used.');
    if (!isChatModel(model)) {
      throw new Error('The selected model is not a chat model. No child was created.');
    }
  }
  const child = createSession(parent?.workspaceId, parentId, parent ? getSessionWorkspaceIds(parent).slice(1) : undefined);
  child.title = (title?.trim() || task.trim().slice(0, 40)) || 'Sub-agent';
  child.providerId = targetProviderId;
  child.modelId = targetModelId;
  child.mode = parent?.mode; // inherit the parent's tool-execution policy
  child.disabledTools = parent.disabledTools ? [...parent.disabledTools] : undefined;
  child.offline = parent.offline;
  child.incognito = parent.incognito;
  saveSession(child);
  let failed = false;
  // Stopping the parent stops the child: otherwise the parent's turn sat on
  // this await until the orphaned sub-agent finished on its own.
  const stopChild = () => abortChat(child.id);
  signal?.addEventListener('abort', stopChild, { once: true });
  try {
    await sendChat({ sessionId: child.id, providerId: targetProviderId, modelId: targetModelId, text: task }, (event) => {
      if (event.sessionId === child.id && event.type === 'error') failed = true;
      send(event);
    });
  } finally {
    signal?.removeEventListener('abort', stopChild);
  }
  if (signal?.aborted) throw new Error('Stopped with the chat.');
  if (failed) throw new Error('The sub-agent failed on the selected provider/model. No fallback was used.');
  const done = getSession(child.id);
  const last = [...(done?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  return last?.content ?? 'Sub-agent finished without producing a written answer.';
}

function sendOptionsForQueuedItem(base: SendOptions, item: QueuedPrompt): SendOptions {
  const payload = queueItemPayload(item);
  return {
    ...base,
    text: payload.text,
    images: payload.images,
    skill: payload.skill,
  };
}

/** Run a chat turn end to end. */
export async function sendChat(opts: SendOptions, send: Sender, allowBrowserControl = false, queued?: { index: number; item: QueuedPrompt }): Promise<void> {
  const settings = getSettings();
  const provider = settings.providers.find((p) => p.id === opts.providerId);
  if (!provider?.enabled) {
    send({ type: 'error', sessionId: opts.sessionId, message: 'Provider not configured or disabled.' });
    return;
  }
  const session = getSession(opts.sessionId);
  if (!session) {
    send({ type: 'error', sessionId: opts.sessionId, message: 'Session not found.' });
    return;
  }

  if (!session.incognito && !session.offline) {
    let created: ReturnType<typeof prepareChatWorktrees>;
    const before = JSON.stringify(session.gitWorktrees);
    try {
      created = prepareChatWorktrees(session, settings);
    } catch (error) {
      send({ type: 'error', sessionId: opts.sessionId, message: (error as Error).message });
      return;
    }
    const announce = () => { saveSession(session); send({ type: 'session_meta', sessionId: session.id }); };
    if (JSON.stringify(session.gitWorktrees) !== before) announce();
    // A fresh checkout has no dependencies: run the project's setup command
    // there before the agent starts, with its output in the Agent commands log.
    for (const { id, checkout } of created) {
      const command = settings.workspaces.find((w) => w.id === id)?.worktreeSetup?.trim();
      if (!command) continue;
      const notice = checkout.notice;
      const setNotice = (text: string) => {
        for (const w of Object.values(session.gitWorktrees ?? {})) if (w.root === checkout.root) w.notice = `${notice} ${text}`;
      };
      setNotice(`Running setup: ${command}`);
      announce();
      appendAgentTerminal(session.id, id, `\r\n$ ${command}  (worktree setup in ${checkout.path})\r\n`);
      const result = await runWorktreeSetup(command, checkout.path, (text) => appendAgentTerminal(session.id, id, text.replace(/[^\x09\x0a\x20-\x7e\u0080-￿]/g, '').replace(/\n/g, '\r\n')));
      setNotice(result.ok
        ? `Setup ran: ${command}.`
        : `Setup failed (${result.detail}): ${command}. Dependencies may be missing; see the Agent commands terminal.`);
      announce();
    }
  }
  const workspaces = chatWorkspaces(session, settings);
  const toolSettings = { ...settings, workspaces };

  // Per-chat policy.
  const mode = session.mode ?? settings.defaultChatMode ?? 'guardrails';
  const offline = !!session.offline;
  const incognito = !!session.incognito;
  if (offline && !offlineProviderAllowed(provider)) {
    send({ type: 'error', sessionId: opts.sessionId, message: 'Offline chat requires a local-compatible provider with a loopback HTTP(S) endpoint.' });
    return;
  }
  if (!providerEndpoint(provider)) {
    send({ type: 'error', sessionId: opts.sessionId, message: 'Provider requires a valid HTTP(S) endpoint.' });
    return;
  }
  const abort = new AbortController();
  abortControllers.set(opts.sessionId, abort);
  // Offline disables tool calls entirely; otherwise combine builtins + connected
  // MCP tools, then drop any the user turned off for this chat.
  // Orchestration: the strategy decides whether sub-agents are even offered.
  const orchestration = settings.orchestration ?? DEFAULT_ORCHESTRATION;
  const allowSpawn = getStrategy(orchestration.strategy).allowsSpawn;
  const canAsk = !session.parentSessionId && !session.taskId && !session.trainingRunId;
  let tools: typeof BUILTIN_TOOLS = [];
  let decideWith: import('@agent-nekko/shared').DecisionProvider | null = null;
  if (!offline) {
    if (settings.mcpServers?.some((s) => s.enabled)) await syncMcp(settings.mcpServers);
    const disabled = new Set(session.disabledTools ?? []);
    if (!allowSpawn) disabled.add('spawn_agent');
    if (!allowBrowserControl || !canAsk) { disabled.add('browser'); disabled.add('capture'); }
    tools = [...BUILTIN_TOOLS, ...mcpToolSpecs(), ...(!session.incognito && !session.trainingRunId ? [AGENT_WATCH_TOOL] : [])].filter((t) => !disabled.has(t.name));
    // update_plan goes to every session: goal runs treat it as the execution
    // contract; ordinary chats publish it to the plan rail so the user sees the
    // plan the agent derived, not a re-listing of their own prompt.
    tools.push(UPDATE_PLAN_TOOL);
    if (session.titleAuto !== false && !session.parentSessionId) tools.push({
      name: 'set_chat_title',
      description: 'Name this chat with a concise, specific 3-6 word title. Never overrides a user-chosen title.',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
    });
    if (!incognito && !session.parentSessionId && !session.trainingRunId && !disabled.has('complete_session')) tools.push({
      name: 'complete_session',
      description: 'Mark this chat completed using the app’s Complete action (archive it). Call only when the user explicitly asks to complete this session. Does not delete messages, clean up worktrees, or stop this final reply. Archived chats follow the app’s archive retention policy. Queued prompts remain saved but will not run automatically.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    });
    // Run-driven sessions can register experiments into their run's idea maze
    // and report the artifacts they produce.
    if (session.trainingRunId) tools.push(REPORT_EXPERIMENT_TOOL, REPORT_ARTIFACT_TOOL);
    // Asking is only offered where somebody is there to answer. A sub-agent, an
    // automation, or a goal run has no one reading it, so a question would be a
    // run parked forever rather than a clarification.
    if (canAsk && !disabled.has(ASK_USER_TOOL.name)) tools.push(ASK_USER_TOOL);
    decideWith = disabled.has(DECIDE_TOOL.name) ? null : await decisions?.available().catch(() => null) ?? null;
    if (decideWith) tools.push(DECIDE_TOOL);
  }
  // Persist only when not incognito. Preserve any prompts queued mid-run (they
  // land on disk via queuePrompt) so a normal save doesn't clobber them.
  const persist = () => {
    if (incognito) return;
    saveTurnSession(session);
  };

  // Build context with provenance. Offline mode skips internet connectors.
  const bundle = assembleContext({
    attached: collectAttached([...(session.attachedPaths ?? []), ...(opts.attachedPaths ?? [])]),
    guidelines: collectGuidelines(workspaces),
    memory: [
      ...listMemory('global'),
      ...getSessionWorkspaceIds(session).flatMap((id) => listMemory('workspace', id)),
    ],
    connectorSnippets: offline ? [] : await collectConnectorSnippets(opts.text),
    indexSnippets: session.gitWorktrees && Object.keys(session.gitWorktrees).length ? [] : collectIndexSnippets(getSessionWorkspaceIds(session), opts.text),
    excluded: new Set(session.contextPrefs?.excluded ?? []),
    pinned: new Set(session.contextPrefs?.pinned ?? []),
  });
  // The real text of each item, not its 160-character preview. Rendering the
  // block from previews is what made an attached file arrive at the model as a
  // single truncated line while the inspector reported its full token cost.
  const contextBlock = renderContextBlock(bundle, bundle.contents ?? new Map());

  const system = buildSystemPrompt({
    workspaces,
    systemInstructions: [settings.systemInstructions, tools.some((t) => t.name === 'agent_watch')
      ? 'When work must wait for PR checks or another background task, register agent_watch before ending the turn. State its id and wake condition; do not claim to be watching unless registration succeeded. Use a deadline so waiting cannot silently last forever. On wake, verify current status and re-arm if necessary. Do not register automatic continuations when waiting for a user decision, missing permission, credentials, or visual evidence that requires human action.'
      : ''].filter(Boolean).join('\n\n'),
    turnWrapper: settings.turnWrapper ?? DEFAULT_TURN_WRAPPER,
    aboutUser: settings.aboutUser,
    checkoutNotice: session.gitIsolation === false ? 'This chat uses the project’s current Git branch, including local changes.' : Object.values(session.gitWorktrees ?? {}).map((w) => w.notice).join('\n'),
    contextBlock,
    platform: process.platform,
    canAsk: tools.some((t) => t.name === ASK_USER_TOOL.name),
    canPlan: tools.some((t) => t.name === UPDATE_PLAN_TOOL.name),
    orchestrationHint: tools.some((t) => t.name === 'spawn_agent')
      ? `${orchestrationPromptHint(orchestration)}\n\n${routingPrompt(settings.providers)}`
      : '',
  });

  if (abort.signal.aborted) {
    if (abortControllers.get(opts.sessionId) === abort) abortControllers.delete(opts.sessionId);
    return;
  }
  if (opts.resume) {
    // Carrying on from a run that stopped part-way: keep every step already taken
    // and only make the transcript valid to send again, by answering any tool call
    // that never got to run. Nothing is appended and nothing is dropped.
    repairInterruptedHistory(session.messages);
  } else if (opts.regenerate) {
    // Re-answer the last user turn: drop trailing assistant/tool messages, but
    // never a compaction summary, which stands in for everything before it.
    while (
      session.messages.length &&
      session.messages[session.messages.length - 1].role !== 'user' &&
      !session.messages[session.messages.length - 1].compaction
    ) {
      session.messages.pop();
    }
  } else {
    // Append the user message.
    const userMsg: ChatMessage = {
      id: `msg_${Date.now().toString(36)}`,
      role: 'user',
      content: opts.text,
      createdAt: Date.now(),
      ...(opts.images?.length ? { images: opts.images } : {}),
      ...(opts.skill ? { skill: opts.skill } : {}),
    };
    session.messages.push(userMsg);
    if (session.title === 'New chat') {
      // Placeholder until the post-turn summarizer writes the real one; the
      // flag says the app named it, so a better name may replace it.
      session.title = opts.text.slice(0, 48) || 'New chat';
      session.titleAuto = true;
    }
  }
  session.providerId = opts.providerId;
  session.modelId = opts.modelId;
  if (queued) {
    try {
      saveTurnSession(session, queued);
      send({ type: 'session_meta', sessionId: opts.sessionId });
    } catch (e) {
      if (abortControllers.get(opts.sessionId) === abort) abortControllers.delete(opts.sessionId);
      send({ type: 'error', sessionId: opts.sessionId, message: (e as Error).message });
      return;
    }
  } else persist();

  let resolvedProvider: ProviderConfig;
  try {
    resolvedProvider = await resolveSubscriptionProvider(provider);
  } catch (e) {
    if (abortControllers.get(opts.sessionId) === abort) abortControllers.delete(opts.sessionId);
    send({ type: 'error', sessionId: opts.sessionId, message: (e as Error).message });
    return;
  }
  let attempts = 0;
  let eventsSeen = false;
  let lastError: Error | undefined;
  while (attempts < 2 && !abort.signal.aborted) {
    abortControllers.set(opts.sessionId, abort);
    eventsSeen = false;

    const requestApproval = (call: ToolCall, reason: string, severity: 'low' | 'medium' | 'high') =>
      new Promise<boolean>((resolveP) => {
        pendingApprovals.set(call.id, resolveP);
        setPending(opts.sessionId, { approval: { call, reason, severity, requestedAt: Date.now() } });
        send({ type: 'tool_approval_required', sessionId: opts.sessionId, call, reason, severity });
      });

    /**
     * Park the turn on a question and wait. The board and the chat both answer
     * it, which is the point: a question asked while you were somewhere else is
     * answerable from wherever you are when you notice it.
     */
    const askUser = async (call: ToolCall): Promise<string> => {
      const parsed = parseAskRequest(call.id, call.input);
      if ('error' in parsed) return parsed.error;
      const request = parsed.request;
      // A chat left running unattended does not park on a question for ever:
      // past the limit the agent is told nobody answered and to decide itself.
      // Approvals never time out this way; only questions do.
      const unattendedMs = Math.max(0, getSettings().unattendedQuestionMinutes ?? 0) * 60_000;
      let unattended = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answers = await new Promise<AskAnswer[]>((resolveP) => {
        pendingAnswers.set(call.id, (a) => {
          clearTimeout(timer);
          resolveP(a);
        });
        setPending(opts.sessionId, { question: request });
        send({ type: 'question', sessionId: opts.sessionId, request });
        if (unattendedMs > 0) {
          timer = setTimeout(() => {
            unattended = true;
            resolveQuestion(opts.sessionId, call.id, []);
          }, unattendedMs);
        }
      });
      send({ type: 'question_resolved', sessionId: opts.sessionId, callId: call.id });
      if (answers.length === 0) return unattended ? ASK_UNATTENDED : ASK_CANCELLED;
      return formatAskAnswers(request, answers);
    };

    try {
      const defaultCwd = workspaces[0]?.path;
      const runOptions = {
        sessionId: opts.sessionId,
        provider: createProvider(resolvedProvider),
        model: opts.modelId,
        system,
        history: session.messages,
        tools,
        executeTool: async (call: ToolCall): Promise<ToolResult> => {
          if (!tools.some((tool) => tool.name === call.name)) {
            return { toolCallId: call.id, output: 'This tool is disabled or unavailable for this chat.', isError: true };
          }
          if (call.name === 'set_chat_title') {
            const disk = getSession(session.id);
            if (disk?.titleAuto === false) return { toolCallId: call.id, output: 'The chat already has a chosen title; it was not changed.' };
            const title = typeof call.input.title === 'string' ? call.input.title.trim().replace(/\s+/g, ' ').slice(0, 64) : '';
            if (!title) return { toolCallId: call.id, output: 'A nonblank title is required.', isError: true };
            session.title = title;
            session.titleAuto = false;
            persist();
            send({ type: 'session_meta', sessionId: session.id });
            return { toolCallId: call.id, output: 'Chat title updated.' };
          }
          if (call.name === 'complete_session') {
            if (Object.keys(call.input).length > 0) return { toolCallId: call.id, output: 'complete_session takes no arguments and only completes the current chat.', isError: true };
            const disk = getSession(session.id);
            if (!disk) return { toolCallId: call.id, output: 'Session not found; completion was not saved.', isError: true };
            const saved = setSessionOptions(session.id, { archivedAt: disk.archivedAt ?? Date.now() });
            if (!saved) return { toolCallId: call.id, output: 'Session not found; completion was not saved.', isError: true };
            session.archivedAt = saved.archivedAt;
            send({ type: 'session_meta', sessionId: session.id });
            return { toolCallId: call.id, output: 'This session is marked completed (archived). Messages are retained under the app’s archive retention policy. You can restore it from completed chats.' };
          }
          if (call.name === ASK_USER_TOOL.name) {
            return { toolCallId: call.id, output: await askUser(call) };
          }
          if (call.name === DECIDE_TOOL.name && decisions && decideWith) {
            try {
              const res = await decisions.run(decideWith, decideRequestFromTool(call.input));
              return { toolCallId: call.id, output: JSON.stringify({ model: res.model, provider: res.provider, answers: res.answers }) };
            } catch (e) {
              return { toolCallId: call.id, output: `decide failed: ${(e as Error).message}`, isError: true };
            }
          }
          const indirect = call.name === 'spawn_agent' || isMcpTool(call.name);
          if (indirect && (mode === 'ask' || settings.sandboxMode === 'ask-everything')) {
            const approved = await requestApproval(call, call.name === 'spawn_agent' ? 'Delegate work to a sub-agent' : `Call ${call.name}`, 'medium');
            if (!approved) return { toolCallId: call.id, output: 'Call not approved by user.', isError: true };
          }
          if (call.name === 'report_experiment' && session.trainingRunId) {
            try {
              const output = reportExperiment(opts.sessionId, call.input as Record<string, unknown>);
              return Promise.resolve({ toolCallId: call.id, output });
            } catch (e) {
              return Promise.resolve({ toolCallId: call.id, output: `Failed to record: ${(e as Error).message}`, isError: true });
            }
          }
          if (call.name === 'report_artifact' && session.trainingRunId) {
            try {
              const output = reportArtifact(opts.sessionId, call.input as Record<string, unknown>);
              return Promise.resolve({ toolCallId: call.id, output });
            } catch (e) {
              return Promise.resolve({ toolCallId: call.id, output: `Failed to record the artifact: ${(e as Error).message}`, isError: true });
            }
          }
          if (call.name === 'update_plan') {
            try {
              const input = call.input as Record<string, unknown>;
              // Run sessions write the run's plan (and mirror it onto the
              // session so the plan rail can render it too); ordinary chats
              // write session.agentPlan directly. Either way the rail needs a
              // session_meta poke to re-read.
              const output = session.trainingRunId
                ? updateRunPlan(opts.sessionId, input)
                : updateSessionPlan(session, input);
              if (session.trainingRunId) session.agentPlan = runPlanForSession(opts.sessionId);
              persist();
              send({ type: 'session_meta', sessionId: opts.sessionId });
              return Promise.resolve({ toolCallId: call.id, output });
            } catch (e) {
              return Promise.resolve({ toolCallId: call.id, output: `Failed to update the plan: ${(e as Error).message}`, isError: true });
            }
          }
          if (call.name === 'agent_watch') {
            try {
              if (session.incognito || session.trainingRunId || session.offline) throw new Error('Durable watches are unavailable in incognito, goal runs, or offline chats');
              const input = call.input as Record<string, unknown>;
              if (input.action === 'create' && (mode === 'ask' || settings.sandboxMode === 'ask-everything') && !await requestApproval(call, 'Schedule an automatic continuation of this chat', 'medium')) {
                throw new Error('Watch registration not approved');
              }
              const output = await agentWatchTool(opts.sessionId, input);
              return { toolCallId: call.id, output };
            } catch (e) {
              return { toolCallId: call.id, output: `Agent watch failed: ${(e as Error).message}`, isError: true };
            }
          }
          if (call.name === 'spawn_agent') {
            return runSubAgent({ ...session, mode }, opts.providerId, opts.modelId, call.input, send, abort.signal)
              .then((output) => ({ toolCallId: call.id, output }))
              .catch((e) => ({ toolCallId: call.id, output: `Sub-agent failed: ${(e as Error).message}`, isError: true }));
          }
          return isMcpTool(call.name)
            ? callMcpTool(call)
            : executeTool(call, {
                settings: toolSettings,
                defaultCwd,
                requestApproval,
                mode,
                allowBrowserControl,
                sessionId: opts.sessionId,
                signal: abort.signal,
              });
        },
        temperature: EFFORT_TEMPERATURE[effectiveEffort(settings.effort, opts.modelId)],
        effort: settings.effort ?? 'normal',
        // The output cap is a safeguard for local servers, where a looping
        // model streams until its context fills. Cloud providers run to their
        // own ceilings; a cap of 8k there cut long replies off mid-sentence.
        maxOutputTokens: isLocalProvider(provider.kind) ? clampMaxOutputTokens(settings.maxOutputTokens) : undefined,
        think: session.thinking,
        maxHistoryTurns: opts.maxHistoryTurns,
        resume: opts.resume,
        pullSteering: () => steering.get(opts.sessionId)?.splice(0) ?? [],
        signal: abort.signal,
        onHeaders:
          provider.kind === 'anthropic' && provider.auth === 'subscription' && provider.tokenKey
            ? (headers: Headers) => LimitsService.recordFromHeaders(provider.tokenKey!, provider.kind, headers)
            : undefined,
      };
      // Under the engine daemon the run itself is the daemon's (daemon-loop.ts):
      // its tokens reach the UI without passing through this process. A run
      // that reports rate-limit headers stays here, since only this side
      // records them. Only a daemon that runs with no tool-step limit gets the
      // run (daemonRunsLoops): an older one would cap it.
      // NEKKO_AGENT_LOOP=ts keeps every run in this process (a kill switch).
      const daemon = process.env.NEKKO_AGENT_LOOP === 'ts' ? undefined : daemonCall();
      const viaDaemon = !!daemon && !runOptions.onHeaders && (await daemonRunsLoops(daemon));
      // On disk while the turn runs: a host that starts and finds it knows the
      // turn was cut off, and marks the reply so the chat offers Continue
      // (reconcileInterruptedChats).
      session.activeRun = { startedAt: Date.now() };
      persist();
      const source = viaDaemon
        ? runAgentViaDaemon(daemon, {
            ...runOptions,
            provider: resolvedProvider,
            requestApproval,
            onRunId: (runId) => daemonRunIds.set(opts.sessionId, runId),
            // The built-in file and shell tools run in the daemon too.
            toolContext: {
              native: tools.map((t) => t.name).filter((n) => DAEMON_TOOLS.has(n)),
              sessionId: opts.sessionId,
              mode,
              sandboxMode: settings.sandboxMode,
              guardrails: settings.guardrails,
              workspaces: workspaces.map((w) => ({ id: w.id, path: w.path })),
              defaultCwd,
            },
          })
        : runAgent(runOptions);
      for await (const event of source) {
        eventsSeen = true;
        if (event.type === 'usage') {
          recordUsage({
            ts: Date.now(),
            providerId: opts.providerId,
            modelId: opts.modelId,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            sessionId: opts.sessionId,
            auth: provider.auth,
          });
        }
        // How the reply ended, for tuning the loop detector (counts only). Older engines omit `stop`; nothing is recorded then.
        if (event.type === 'done' && event.stop && !incognito) {
          recordReply({
            ts: Date.now(),
            sessionId: opts.sessionId,
            providerId: opts.providerId,
            modelId: opts.modelId,
            steps: event.steps ?? 0,
            stop: event.stop,
          });
        }
        if (event.type === 'done' && provider.auth === 'subscription' && provider.tokenKey) {
          LimitsService.poll(provider.tokenKey).catch(() => {});
        }
        // Checkpoint after every completed step, not just at the end. The agent
        // loop appends each assistant message and tool result to `session.messages`
        // as it goes, so writing here means a run that is killed mid-flight (a
        // timeout, a crash, a quit) leaves the steps it finished on disk to resume
        // from, instead of an hour of tool work existing only in memory.
        //
        // Written before the event goes out, so anything that reacts to it by
        // re-reading the session (the chat pane does exactly that on `done`) is
        // guaranteed to find the step it was just told about.
        if (event.type === 'tool_result' || event.type === 'step' || event.type === 'steered' || event.type === 'done' || event.type === 'error') {
          persist();
        }
        send(event);
        // The steering message is in the transcript now; panes re-read it.
        if (event.type === 'steered') send({ type: 'session_meta', sessionId: opts.sessionId });
      }
      lastError = undefined;
      break;
    } catch (e) {
      const message = (e as Error).message;
      if (provider.auth === 'subscription' && !eventsSeen && attempts === 0 && isAuthFailure(message)) {
        attempts++;
        try {
          resolvedProvider = { ...provider, apiKey: await ensureFreshToken(provider.tokenKey!, true) };
          continue;
        } catch (refreshErr) {
          lastError = refreshErr as Error;
          break;
        }
      }
      lastError = e as Error;
      break;
    } finally {
      if (abortControllers.get(opts.sessionId) === abort) abortControllers.delete(opts.sessionId);
      // The turn is over, so nothing it was waiting on can still be answered.
      // Leaving the entry behind would park the session in the board's "needs
      // you" lane over a question that no longer has a run behind it.
      releasePending(opts.sessionId);
      delete session.activeRun;
      daemonRunIds.delete(opts.sessionId);
      persist();
    }
  }

  if (abortControllers.get(opts.sessionId) === abort) abortControllers.delete(opts.sessionId);
  finishAgentTerminal(opts.sessionId);
  if (lastError) {
    send({ type: 'error', sessionId: opts.sessionId, message: lastError.message });
  }

  // Keep the linked spec.md in sync with the conversation (best-effort).
  if (session.specLinked && !incognito && !offline) {
    buildSpec(opts.sessionId).catch(() => {});
  }

  // With the first turn done, ask the model for a real title. titleAuto guards
  // a name the user typed; incognito/offline chats skip the extra call.
  if (!incognito && !offline && session.titleAuto === true) {
    void titleSession(opts.sessionId, resolvedProvider, opts.modelId, send);
  }

  // Steering that arrived during the final model call (no tool boundary left
  // to fold it into) runs next, as a queued prompt.
  if (!incognito) {
    for (const m of steering.get(opts.sessionId)?.splice(0) ?? []) queuePrompt(opts.sessionId, m.content);
  }
  steering.delete(opts.sessionId);

  // Run the next queued prompt, if any (and we weren't aborted). Each turn
  // dequeues exactly one item, so a chat works through its queue in order.
  if (!abort.signal.aborted) {
    const fresh = getSession(opts.sessionId);
    const next = fresh?.queue?.[0];
    if (fresh && !fresh.archivedAt && next) {
      await sendChat(sendOptionsForQueuedItem({ sessionId: opts.sessionId, providerId: opts.providerId, modelId: opts.modelId, text: '' }, next), send, allowBrowserControl, { index: 0, item: next });
    }
  }
}
