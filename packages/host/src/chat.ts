import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { AgentEvent, ChatMessage, ContextBundle, ProviderConfig, SendOptions, Session, ToolCall } from '@agent-nekko/shared';
import { EFFORT_TEMPERATURE, DEFAULT_ORCHESTRATION, clampMaxOutputTokens, clampMaxSteps, getSessionWorkspaceIds, getStrategy, isChatModel, isLocalProvider, orchestrationPromptHint } from '@agent-nekko/shared';
import {
  createProvider,
  runAgent,
  buildSystemPrompt,
  assembleContext,
  renderContextBlock,
  isGuidelineFile,
  getConnector,
  BUILTIN_TOOLS,
  REPORT_EXPERIMENT_TOOL,
  REPORT_ARTIFACT_TOOL,
  UPDATE_PLAN_TOOL,
  repairInterruptedHistory,
} from '@agent-nekko/core';
import { reportExperiment, reportArtifact, updateRunPlan } from './training.js';
import { getSettings } from './store.js';
import { getSession, saveSession, createSession } from './sessions.js';
import { executeTool } from './tools.js';
import { recordUsage } from './usage.js';
import * as LimitsService from './limits.js';
import { listMemory } from './memory.js';
import { ensureFreshToken, resolveSubscriptionProvider } from './oauth.js';
import { searchWorkspace } from './workspace.js';
import { buildSpec } from './spec.js';
import { syncMcp, mcpToolSpecs, isMcpTool, callMcpTool } from './mcp.js';

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

const abortControllers = new Map<string, AbortController>();
const pendingApprovals = new Map<string, (approved: boolean) => void>();

function isAuthFailure(message: string): boolean {
  return /\b401\b|unauthorized|invalid auth|invalid api key|authentication/i.test(message);
}

/** Resolve a pending tool approval (called from IPC when the user clicks). */
export function resolveApproval(toolCallId: string, approved: boolean): void {
  pendingApprovals.get(toolCallId)?.(approved);
  pendingApprovals.delete(toolCallId);
}

export function abortChat(sessionId: string): void {
  abortControllers.get(sessionId)?.abort();
  abortControllers.delete(sessionId);
}

/** Read guideline files (AGENTS.md/CLAUDE.md/...) from the workspace roots. */
function collectGuidelines(): Array<{ path: string; content: string }> {
  const settings = getSettings();
  const out: Array<{ path: string; content: string }> = [];
  const names = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.windsurfrules', 'GEMINI.md'];
  for (const w of settings.workspaces) {
    for (const n of names) {
      if (!isGuidelineFile(n)) continue;
      const p = join(w.path, n);
      if (existsSync(p)) {
        try {
          out.push({ path: p, content: readFileSync(p, 'utf8').slice(0, 20000) });
        } catch {
          /* skip */
        }
      }
    }
  }
  return out;
}

function collectAttached(paths: string[]): Array<{ path: string; content: string }> {
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

/**
 * Best-effort context window for the headroom bar, from the model id (no network
 * call). Falls back to a safe 128k when the family is unknown.
 */
function modelContextWindow(modelId?: string): number {
  const id = (modelId ?? '').toLowerCase();
  if (!id) return 128_000;
  if (id.includes('claude')) return 200_000;
  if (id.includes('gemini')) return 1_000_000;
  if (id.includes('gpt-4.1') || id.includes('o3') || id.includes('o4')) return 200_000;
  if (id.includes('gpt-4o') || id.includes('gpt-4') || id.includes('gpt-3.5')) return 128_000;
  if (id.includes('llama') || id.includes('qwen') || id.includes('mistral')) return 128_000;
  return 128_000;
}

/** Build the context bundle for the Context Inspector preview (no model call). */
export async function previewContext(sessionId: string, attachedPaths: string[]): Promise<ContextBundle> {
  const session = getSession(sessionId);
  const settings = getSettings();
  // The base system prompt (no per-turn context block — those items are counted
  // individually below) so the inspector reflects true window usage.
  const systemText = buildSystemPrompt({
    workspaces: settings.workspaces,
    contextBlock: '',
    platform: process.platform,
  });
  return assembleContext({
    attached: collectAttached([...(session?.attachedPaths ?? []), ...attachedPaths]),
    guidelines: collectGuidelines(),
    memory: [
      ...listMemory('global'),
      ...((session ? getSessionWorkspaceIds(session) : []).flatMap((id) => listMemory('workspace', id))),
    ],
    connectorSnippets: !session || session.offline ? [] : await collectConnectorSnippets(),
    indexSnippets: [],
    history: (session?.messages ?? []).map((m) => ({ role: m.role, content: m.content })),
    systemText,
    contextWindow: modelContextWindow(session?.modelId),
    excluded: new Set(session?.contextPrefs?.excluded ?? []),
    pinned: new Set(session?.contextPrefs?.pinned ?? []),
  });
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

function offlineProviderAllowed(provider: ProviderConfig): boolean {
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
  await sendChat({ sessionId: child.id, providerId: targetProviderId, modelId: targetModelId, text: task }, (event) => {
    if (event.sessionId === child.id && event.type === 'error') failed = true;
    send(event);
  });
  if (failed) throw new Error('The sub-agent failed on the selected provider/model. No fallback was used.');
  const done = getSession(child.id);
  const last = [...(done?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  return last?.content ?? 'Sub-agent finished without producing a written answer.';
}

/** Run a chat turn end to end. */
export async function sendChat(opts: SendOptions, send: Sender): Promise<void> {
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
  // Offline disables tool calls entirely; otherwise combine builtins + connected
  // MCP tools, then drop any the user turned off for this chat.
  // Orchestration: the strategy decides whether sub-agents are even offered.
  const orchestration = settings.orchestration ?? DEFAULT_ORCHESTRATION;
  const allowSpawn = getStrategy(orchestration.strategy).allowsSpawn;
  let tools: typeof BUILTIN_TOOLS = [];
  if (!offline) {
    if (settings.mcpServers?.some((s) => s.enabled)) await syncMcp(settings.mcpServers);
    const disabled = new Set(session.disabledTools ?? []);
    if (!allowSpawn) disabled.add('spawn_agent');
    tools = [...BUILTIN_TOOLS, ...mcpToolSpecs()].filter((t) => !disabled.has(t.name));
    // Run-driven sessions can register experiments into their run's idea maze
    // and (goal runs) maintain their execution plan.
    if (session.trainingRunId) tools.push(REPORT_EXPERIMENT_TOOL, REPORT_ARTIFACT_TOOL, UPDATE_PLAN_TOOL);
  }
  // Persist only when not incognito. Preserve any prompts queued mid-run (they
  // land on disk via queuePrompt) so a normal save doesn't clobber them.
  const persist = () => {
    if (incognito) return;
    const disk = getSession(session.id);
    if (disk?.queue) session.queue = disk.queue;
    saveSession(session);
  };

  // Build context with provenance. Offline mode skips internet connectors.
  const bundle = assembleContext({
    attached: collectAttached([...(session.attachedPaths ?? []), ...(opts.attachedPaths ?? [])]),
    guidelines: collectGuidelines(),
    memory: [
      ...listMemory('global'),
      ...getSessionWorkspaceIds(session).flatMap((id) => listMemory('workspace', id)),
    ],
    connectorSnippets: offline ? [] : await collectConnectorSnippets(opts.text),
    indexSnippets: collectIndexSnippets(getSessionWorkspaceIds(session), opts.text),
    excluded: new Set(session.contextPrefs?.excluded ?? []),
    pinned: new Set(session.contextPrefs?.pinned ?? []),
  });
  const contents = new Map<string, string>();
  for (const item of bundle.items) contents.set(item.id, item.preview);
  const contextBlock = renderContextBlock(bundle, contents);

  const system = buildSystemPrompt({
    workspaces: settings.workspaces,
    contextBlock,
    platform: process.platform,
    orchestrationHint: tools.some((t) => t.name === 'spawn_agent')
      ? `${orchestrationPromptHint(orchestration)}\n\n${routingPrompt(settings.providers)}`
      : '',
  });

  if (opts.resume) {
    // Carrying on from a run that stopped part-way: keep every step already taken
    // and only make the transcript valid to send again, by answering any tool call
    // that never got to run. Nothing is appended and nothing is dropped.
    repairInterruptedHistory(session.messages);
  } else if (opts.regenerate) {
    // Re-answer the last user turn: drop trailing assistant/tool messages.
    while (session.messages.length && session.messages[session.messages.length - 1].role !== 'user') {
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
    if (session.title === 'New chat') session.title = opts.text.slice(0, 48) || 'New chat';
  }
  session.providerId = opts.providerId;
  session.modelId = opts.modelId;
  persist();

  let resolvedProvider: ProviderConfig;
  try {
    resolvedProvider = await resolveSubscriptionProvider(provider);
  } catch (e) {
    send({ type: 'error', sessionId: opts.sessionId, message: (e as Error).message });
    return;
  }
  let attempts = 0;
  let eventsSeen = false;
  let lastError: Error | undefined;
  let abort = new AbortController();

  while (attempts < 2) {
    abort = new AbortController();
    abortControllers.set(opts.sessionId, abort);
    eventsSeen = false;

    const requestApproval = (call: ToolCall, reason: string, severity: 'low' | 'medium' | 'high') =>
      new Promise<boolean>((resolveP) => {
        pendingApprovals.set(call.id, resolveP);
        send({ type: 'tool_approval_required', sessionId: opts.sessionId, call, reason, severity });
      });

    try {
      for await (const event of runAgent({
        sessionId: opts.sessionId,
        provider: createProvider(resolvedProvider),
        model: opts.modelId,
        system,
        history: session.messages,
        tools,
        executeTool: async (call) => {
          if (!tools.some((tool) => tool.name === call.name)) {
            return { toolCallId: call.id, output: 'This tool is disabled or unavailable for this chat.', isError: true };
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
          if (call.name === 'update_plan' && session.trainingRunId) {
            try {
              const output = updateRunPlan(opts.sessionId, call.input as Record<string, unknown>);
              return Promise.resolve({ toolCallId: call.id, output });
            } catch (e) {
              return Promise.resolve({ toolCallId: call.id, output: `Failed to update the plan: ${(e as Error).message}`, isError: true });
            }
          }
          if (call.name === 'spawn_agent') {
            return runSubAgent({ ...session, mode }, opts.providerId, opts.modelId, call.input, send)
              .then((output) => ({ toolCallId: call.id, output }))
              .catch((e) => ({ toolCallId: call.id, output: `Sub-agent failed: ${(e as Error).message}`, isError: true }));
          }
          return isMcpTool(call.name)
            ? callMcpTool(call)
            : executeTool(call, {
                settings,
                defaultCwd: session.workspaceId
                  ? settings.workspaces.find((w) => w.id === session.workspaceId)?.path ?? settings.workspaces[0]?.path
                  : settings.workspaces[0]?.path,
                requestApproval,
                mode,
                sessionId: opts.sessionId,
              });
        },
        temperature: EFFORT_TEMPERATURE[settings.effort ?? 'normal'],
        maxIterations: clampMaxSteps(settings.maxSteps),
        maxOutputTokens: clampMaxOutputTokens(settings.maxOutputTokens),
        think: session.thinking,
        maxHistoryTurns: opts.maxHistoryTurns,
        resume: opts.resume,
        signal: abort.signal,
        onHeaders:
          provider.kind === 'anthropic' && provider.auth === 'subscription' && provider.tokenKey
            ? (headers) => LimitsService.recordFromHeaders(provider.tokenKey!, provider.kind, headers)
            : undefined,
      })) {
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
        if (event.type === 'tool_result' || event.type === 'done' || event.type === 'error') {
          persist();
        }
        send(event);
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
      abortControllers.delete(opts.sessionId);
      persist();
    }
  }

  if (lastError) {
    send({ type: 'error', sessionId: opts.sessionId, message: lastError.message });
  }

  // Keep the linked spec.md in sync with the conversation (best-effort).
  if (session.specLinked && !incognito && !offline) {
    buildSpec(opts.sessionId).catch(() => {});
  }

  // Run the next queued prompt, if any (and we weren't aborted). Each turn
  // dequeues exactly one item, so a chat works through its queue in order.
  if (!abort.signal.aborted) {
    const fresh = getSession(opts.sessionId);
    const next = fresh?.queue?.[0];
    if (fresh && next) {
      fresh.queue = fresh.queue!.slice(1);
      saveSession(fresh);
      await sendChat({ sessionId: opts.sessionId, providerId: opts.providerId, modelId: opts.modelId, text: next }, send);
    }
  }
}
