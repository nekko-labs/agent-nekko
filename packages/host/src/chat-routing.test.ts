import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ModelInfo, ProviderConfig, Session } from '@agent-nekko/shared';
import type { ChatRequest, Provider, ProviderChunk } from '@agent-nekko/core';

let requests: Array<{ providerId: string; request: ChatRequest }> = [];
let listings: string[] = [];
let rounds: Array<ProviderChunk[] | Error> = [];
let models: ModelInfo[] = [];
let listingError = false;
const buildSpec = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const syncMcp = vi.hoisted(() => vi.fn(async () => {}));
const mcpToolSpecs = vi.hoisted(() => vi.fn(() => [] as Array<{ name: string; description: string; parameters: { type: 'object'; properties: Record<string, never> } }>));
const isMcpTool = vi.hoisted(() => vi.fn((name: string) => name.startsWith('mcp__')));
const callMcpTool = vi.hoisted(() => vi.fn(async (call: { id: string }) => ({ toolCallId: call.id, output: 'mcp result' })));
const connectorFetch = vi.hoisted(() => vi.fn(async () => []));

vi.mock('./spec.js', () => ({ buildSpec }));
vi.mock('./mcp.js', () => ({ syncMcp, mcpToolSpecs, isMcpTool, callMcpTool }));
vi.mock('@agent-nekko/core', async () => {
  const actual = await vi.importActual<typeof import('@agent-nekko/core')>('@agent-nekko/core');
  return {
    ...actual,
    getConnector: () => ({ fetch: connectorFetch }),
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      async listModels() {
        listings.push(config.id);
        if (listingError) throw new Error('private-token https://private.example/models');
        return models;
      },
      test: async () => ({ ok: true, message: '' }),
      async *chat(request) {
        requests.push({ providerId: config.id, request });
        const step = rounds.shift() ?? [{ type: 'text', delta: 'answer' }, { type: 'done' }];
        if (step instanceof Error) throw step;
        for (const chunk of step) yield chunk;
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, getSession, saveSession, listSessions } = await import('./sessions.js');
const { sendChat, previewContext, resolveApproval } = await import('./chat.js');
const { BUILTIN_TOOLS } = await import('@agent-nekko/core');
let dir: string;
let providers: ProviderConfig[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kotrain-routing-'));
  setDataDir(dir);
  providers = [
    { id: 'frontier', kind: 'anthropic', label: 'Frontier', baseUrl: 'https://private.example', apiKey: 'private-token', enabled: true },
    { id: 'local', kind: 'openai-compat', label: 'Local worker', baseUrl: 'http://127.0.0.1:1234/v1', enabled: true },
    { id: 'disabled', kind: 'ollama', label: 'Disabled worker', baseUrl: 'http://localhost:11434', enabled: false },
  ];
  saveSettings({ providers, workspaces: [], defaultChatMode: 'yolo' });
  requests = [];
  listings = [];
  rounds = [];
  models = [{ id: 'local-exact', providerId: 'local', name: 'Local exact' }];
  listingError = false;
  vi.clearAllMocks();
  mcpToolSpecs.mockReturnValue([]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function delegate(input: unknown) {
  rounds = [[{ type: 'tool_call', call: { id: 'spawn1', name: 'spawn_agent', input: input as Record<string, unknown> } }, { type: 'done' }]];
}

async function run(session = createSession(), providerId = 'frontier', modelId = 'frontier-exact') {
  const events: AgentEvent[] = [];
  await sendChat({ sessionId: session.id, providerId, modelId, text: 'delegate this' }, (event) => events.push(event));
  return { session, events, result: events.find((event) => event.type === 'tool_result' && event.sessionId === session.id) };
}

function children(parent: Session) {
  return listSessions().filter((session) => session.parentSessionId === parent.id);
}

describe('offline context preview', () => {
  it('does not fetch connectors for an offline session or missing session', async () => {
    saveSettings({ connectors: [{ kind: 'slack', connected: true, token: 'test-token' }] });
    const session = createSession();
    session.offline = true;
    saveSession(session);
    await previewContext(session.id, []);
    await previewContext('missing-session', []);
    expect(connectorFetch).not.toHaveBeenCalled();
  });

  it('keeps connector previews available for an online session', async () => {
    saveSettings({ connectors: [{ kind: 'slack', connected: true, token: 'test-token' }] });
    await previewContext(createSession().id, []);
    expect(connectorFetch).toHaveBeenCalledOnce();
  });
});

describe('explicit sub-agent routing', () => {
  it('offers optional targets while keeping task required', () => {
    expect(BUILTIN_TOOLS.find((tool) => tool.name === 'spawn_agent')?.parameters).toMatchObject({
      properties: { provider_id: { type: 'string' }, model_id: { type: 'string' } },
      required: ['task'],
    });
  });

  it('inherits provider and exact model without listing or fallback', async () => {
    delegate({ task: 'child task' });
    const { session, result } = await run();
    expect(children(session)).toHaveLength(1);
    expect(children(session)[0]).toMatchObject({ providerId: 'frontier', modelId: 'frontier-exact' });
    expect(requests.map((r) => [r.providerId, r.request.model])).toEqual([
      ['frontier', 'frontier-exact'], ['frontier', 'frontier-exact'], ['frontier', 'frontier-exact'],
    ]);
    expect(listings).toEqual([]);
    expect(result).toMatchObject({ result: { output: 'answer' } });
  });

  it('routes frontier to an explicitly named local model and inherits policy', async () => {
    const parent = createSession();
    parent.mode = 'guardrails';
    parent.disabledTools = ['bash', 'write_file'];
    parent.offline = false;
    parent.incognito = false;
    saveSession(parent);
    delegate({ title: 'Local task', task: 'child task', provider_id: 'local', model_id: 'local-exact' });
    const { result } = await run(parent);
    expect(children(parent)[0]).toMatchObject({ title: 'Local task', providerId: 'local', modelId: 'local-exact', mode: 'guardrails', disabledTools: ['bash', 'write_file'], offline: false, incognito: false });
    expect(listings).toEqual(['local']);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'local', 'frontier']);
    expect(requests[1].request.tools?.some((t) => ['bash', 'write_file'].includes(t.name))).toBe(false);
    expect(result).toMatchObject({ result: { output: 'answer' } });
  });

  it('allows an explicit model on the inherited provider', async () => {
    models = [{ id: 'other-exact', providerId: 'frontier', name: 'Other' }];
    delegate({ task: 'child task', model_id: 'other-exact' });
    const { session } = await run();
    expect(children(session)[0]).toMatchObject({ providerId: 'frontier', modelId: 'other-exact' });
    expect(listings).toEqual(['frontier']);
  });

  it.each([
    { task: 'child', provider_id: 'unknown', model_id: 'local-exact' },
    { task: 'child', provider_id: 'disabled', model_id: 'local-exact' },
    { task: 'child', provider_id: 'local' },
    { task: 'child', provider_id: '' },
    { task: 'child', provider_id: '  ' },
    { task: 'child', provider_id: 123 },
    { task: 'child', model_id: '' },
    { task: 'child', model_id: '  ' },
    { task: 'child', model_id: null },
    { task: 'child', model_id: 123 },
    { task: '' },
    { task: {} },
    {},
    null,
  ])('rejects malformed or unconfigured targets before creating a child: %j', async (input) => {
    delegate(input);
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(session)).toEqual([]);
    expect(listings).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it.each(['absent', 'nonchat', 'unavailable'])('rejects %s explicit models before creating a child', async (failure) => {
    if (failure === 'absent') models = [];
    if (failure === 'nonchat') models = [{ id: 'text-embedding-3-small', name: 'Embedding', providerId: 'local' }];
    if (failure === 'unavailable') listingError = true;
    delegate({ task: 'child', provider_id: 'local', model_id: failure === 'nonchat' ? 'text-embedding-3-small' : 'local-exact' });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(JSON.stringify(result)).not.toContain('https://private.example');
    expect(children(session)).toEqual([]);
    expect(listings).toEqual(['local']);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });

  it.each(['whisper-large-v3', 'bge-m3', 'parakeet-unified-en-0.6b', 'stable-diffusion-xl', 'unlimited-ocr'])('rejects known non-chat model %s without falling back to the unfiltered list', async (modelId) => {
    models = [{ id: modelId, providerId: 'local', name: modelId }];
    delegate({ task: 'child', provider_id: 'local', model_id: modelId });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringMatching(/not a chat model/) } });
    expect(children(session)).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });

  it('returns child model failures as tool errors without retrying another model or provider', async () => {
    delegate({ task: 'child', provider_id: 'local', model_id: 'local-exact' });
    rounds.push(new Error('model unavailable'));
    const { result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(requests.map((r) => [r.providerId, r.request.model])).toEqual([
      ['frontier', 'frontier-exact'], ['local', 'local-exact'], ['frontier', 'frontier-exact'],
    ]);
  });

  it('exposes only enabled provider IDs and labels and requires known exact models', async () => {
    await run();
    const system = requests[0].request.system!;
    expect(system).toContain('frontier');
    expect(system).toContain('Local worker');
    expect(system).not.toContain('Disabled worker');
    expect(system).not.toContain('private-token');
    expect(system).not.toContain('https://private.example');
    expect(system).toMatch(/exact model/i);
    expect(system).toMatch(/never guess/i);
    expect(listings).toEqual([]);
  });

  it('inherits the effective default mode and enforces disabled tools even if the child requests one', async () => {
    const parent = createSession();
    parent.disabledTools = ['bash'];
    saveSession(parent);
    delegate({ task: 'child', provider_id: 'local', model_id: 'local-exact' });
    rounds.push([{ type: 'tool_call', call: { id: 'blocked', name: 'bash', input: { command: 'must-not-run' } } }, { type: 'done' }]);
    const { events } = await run(parent);
    expect(children(parent)[0]).toMatchObject({ mode: 'yolo', disabledTools: ['bash'] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ toolCallId: 'blocked', isError: true, output: expect.stringMatching(/disabled/) }) }));
  });

  it('rejects an invalid provider endpoint before listing models or creating a child', async () => {
    providers[1].baseUrl = 'file:///tmp/model';
    saveSettings({ providers });
    delegate({ task: 'child', provider_id: 'local', model_id: 'local-exact' });
    const { session, result } = await run();
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(session)).toEqual([]);
    expect(listings).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });

  it('does not delegate when spawn_agent is disabled even if the model calls it', async () => {
    const parent = createSession();
    parent.disabledTools = ['spawn_agent'];
    saveSession(parent);
    delegate({ task: 'child' });
    const { result } = await run(parent);
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(parent)).toEqual([]);
    expect(requests[0].request.tools?.some((t) => t.name === 'spawn_agent')).toBe(false);
    expect(requests[0].request.system).not.toContain('enabled configured providers');
  });

  it('requires approval before delegation in ask mode', async () => {
    saveSettings({ providers, workspaces: [], defaultChatMode: 'ask' });
    const parent = createSession();
    delegate({ task: 'child' });
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: parent.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'delegate this' }, (event) => {
      events.push(event);
      if (event.type === 'tool_approval_required') resolveApproval(event.call.id, false);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_approval_required', call: expect.objectContaining({ name: 'spawn_agent' }) }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', result: expect.objectContaining({ isError: true, output: expect.stringMatching(/not approved/i) }) }));
    expect(children(parent)).toEqual([]);
  });

  it('requires approval before calling an MCP tool in ask mode', async () => {
    saveSettings({ providers, workspaces: [], defaultChatMode: 'ask' });
    mcpToolSpecs.mockReturnValue([{ name: 'mcp__server__mutate', description: 'Mutate', parameters: { type: 'object', properties: {} } }]);
    rounds = [[{ type: 'tool_call', call: { id: 'mcp1', name: 'mcp__server__mutate', input: {} } }, { type: 'done' }]];
    const session = createSession();
    const events: AgentEvent[] = [];
    await sendChat({ sessionId: session.id, providerId: 'frontier', modelId: 'frontier-exact', text: 'use MCP' }, (event) => {
      events.push(event);
      if (event.type === 'tool_approval_required') resolveApproval(event.call.id, false);
    });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_approval_required', call: expect.objectContaining({ name: 'mcp__server__mutate' }) }));
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('blocks incognito delegation without creating or persisting child content', async () => {
    const parent = createSession();
    parent.incognito = true;
    saveSession(parent);
    const before = getSession(parent.id);
    delegate({ task: 'private child', provider_id: 'local', model_id: 'local-exact' });
    const { result } = await run(parent);
    expect(result).toMatchObject({ result: { isError: true, output: expect.stringMatching(/incognito/i) } });
    expect(listSessions()).toEqual([before]);
    expect(listings).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['frontier', 'frontier']);
  });
});

describe('offline routing', () => {
  it.each([
    ['openai-compat', 'https://remote.example/v1'],
    ['ollama', 'http://192.168.1.2:11434'],
    ['lmstudio', 'http://localhost.remote.example/v1'],
    ['vllm', 'file:///tmp/model'],
    ['openai-compat', 'not a url'],
    ['openai-compat', 'http://localhost@remote.example/v1'],
    ['anthropic', 'http://localhost:1234'],
    ['openai', 'http://127.0.0.1:1234'],
    ['openrouter', 'http://[::1]:1234'],
  ])('blocks %s at %s before any provider or connector call', async (kind, baseUrl) => {
    providers[1] = { ...providers[1], kind: kind as ProviderConfig['kind'], baseUrl };
    saveSettings({ providers, connectors: [{ kind: 'github', connected: true, token: 'token' }], mcpServers: [{ id: 'm', name: 'MCP', enabled: true, command: 'unused', args: [] }] });
    const session = createSession();
    session.offline = true;
    saveSession(session);
    const { events } = await run(session, 'local', 'local-exact');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/offline/i) }));
    expect(requests).toEqual([]);
    expect(listings).toEqual([]);
    expect(syncMcp).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(getSession(session.id)?.messages).toEqual([]);
  });

  it.each(['http://127.0.0.1:1234/v1', 'https://localhost:1234/v1', 'http://[::1]:1234/v1'])('allows local offline chat at %s without tools or hidden spec calls', async (baseUrl) => {
    providers[1].baseUrl = baseUrl;
    saveSettings({ providers });
    const session = createSession();
    session.offline = true;
    session.specLinked = true;
    saveSession(session);
    const { events } = await run(session, 'local', 'local-exact');
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].request.tools).toEqual([]);
    expect(buildSpec).not.toHaveBeenCalled();
    expect(connectorFetch).not.toHaveBeenCalled();
    expect(syncMcp).not.toHaveBeenCalled();
  });

  it('blocks tool execution and delegation in offline chat even if a model emits a call', async () => {
    const session = createSession();
    session.offline = true;
    saveSession(session);
    delegate({ task: 'child', provider_id: 'frontier', model_id: 'frontier-exact' });
    const { result } = await run(session, 'local', 'local-exact');
    expect(result).toMatchObject({ result: { isError: true } });
    expect(children(session)).toEqual([]);
    expect(listings).toEqual([]);
    expect(requests.map((r) => r.providerId)).toEqual(['local', 'local']);
    expect(requests.every((r) => r.request.tools?.length === 0)).toBe(true);
  });

  it('rejects disabled providers for ordinary chat before model calls', async () => {
    const { events } = await run(createSession(), 'disabled', 'model');
    expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
    expect(requests).toEqual([]);
  });
});
