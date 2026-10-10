import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatGptProvider } from './chatgpt.js';
import type { ProviderConfig } from '@nekko-agent/shared';
import type { ProviderChunk } from './types.js';

const cfg: ProviderConfig = {
  id: 'p1',
  kind: 'chatgpt',
  label: 'ChatGPT',
  baseUrl: 'https://chatgpt.com/backend-api',
  apiKey: 'oauth-access-token',
  auth: 'subscription',
  tokenKey: 'chatgpt:acct-1',
  accountId: 'acct-1',
  enabled: true,
};

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const DONE_STREAM = ['data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n'];

async function collect(provider: ChatGptProvider, req: Parameters<ChatGptProvider['chat']>[0]) {
  const chunks: ProviderChunk[] = [];
  for await (const c of provider.chat(req)) chunks.push(c);
  return chunks;
}

async function runChat(provider: ChatGptProvider, req: Parameters<ChatGptProvider['chat']>[0]) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(DONE_STREAM));
  await collect(provider, req);
  const [url, init] = spy.mock.calls.at(-1) as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}

afterEach(() => vi.restoreAllMocks());

describe('ChatGptProvider requests', () => {
  it('posts to the Codex responses endpoint with the subscription headers', async () => {
    const { url, headers, body } = await runChat(new ChatGptProvider(cfg), {
      model: 'gpt-5-codex',
      messages: [],
      system: 'be terse',
    });
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(headers.Authorization).toBe('Bearer oauth-access-token');
    expect(headers['chatgpt-account-id']).toBe('acct-1');
    expect(headers['OpenAI-Beta']).toBe('responses=experimental');
    expect(headers.originator).toBeTruthy();
    expect(headers.session_id).toBeTruthy();
    expect(body.model).toBe('gpt-5-codex');
    expect(body.instructions).toBe('be terse');
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
  });

  it('maps history, tool calls, and tool results onto Responses input items', async () => {
    const { body } = await runChat(new ChatGptProvider(cfg), {
      model: 'gpt-5-codex',
      messages: [
        { id: 'm1', role: 'user', content: 'hi', createdAt: 0 },
        {
          id: 'm2',
          role: 'assistant',
          content: 'checking',
          toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
          createdAt: 0,
        },
        { id: 'm3', role: 'tool', content: '', toolResult: { toolCallId: 'call_1', output: 'file body' }, createdAt: 0 },
      ],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    });
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
    ]);
  });

  it('never sends sampling or cap params; effort goes out as reasoning.effort', async () => {
    // The Codex backend 400s on `temperature` and `max_output_tokens`.
    const { body } = await runChat(new ChatGptProvider(cfg), {
      model: 'gpt-6-sol',
      messages: [],
      temperature: 0.2,
      maxOutputTokens: 2048,
      effort: 'high',
    });
    expect(body.temperature).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('clamps rungs above Codex\'s ladder and maps low through', async () => {
    const { body } = await runChat(new ChatGptProvider(cfg), {
      model: 'gpt-6-sol',
      messages: [],
      effort: 'xhigh',
    });
    expect(body.reasoning).toEqual({ effort: 'high' });
    const low = await runChat(new ChatGptProvider(cfg), { model: 'gpt-6-sol', messages: [], effort: 'low' });
    expect(low.body.reasoning).toEqual({ effort: 'low' });
  });

  it('sends no rung at the default effort and still maps the think toggle', async () => {
    const { body } = await runChat(new ChatGptProvider(cfg), {
      model: 'gpt-6-sol',
      messages: [],
      effort: 'normal',
      think: true,
    });
    expect(body.reasoning).toEqual({ summary: 'auto' });
  });

  it('throws a sign-in-again error when the account id is missing', async () => {
    const noAccount = new ChatGptProvider({ ...cfg, accountId: undefined });
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(collect(noAccount, { model: 'gpt-5-codex', messages: [] })).rejects.toThrow(/sign in again/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('listModels serves the live catalog when the backend answers', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            { slug: 'gpt-6-sol', display_name: 'GPT-6 Sol', context_window: 272000, priority: 2, visibility: 'list' },
            { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', context_window: 400000, priority: 1, visibility: 'list' },
            { slug: 'gpt-hidden', visibility: 'hide' },
            { slug: 'gpt-unpicked', show_in_picker: false },
          ],
        }),
        { status: 200 },
      ),
    );
    const models = await new ChatGptProvider(cfg).listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol']);
    expect(models[0]).toMatchObject({ providerId: 'p1', name: 'GPT-6 Astra', contextLength: 400000 });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/chatgpt\.com\/backend-api\/codex\/models\?client_version=\d/);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer oauth-access-token');
    expect(headers['chatgpt-account-id']).toBe('acct-1');
    expect(headers.originator).toBeTruthy();
  });

  it('listModels falls back to the curated set when the catalog is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const models = await new ChatGptProvider(cfg).listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.providerId === 'p1')).toBe(true);
  });

  it('listModels falls back on a non-OK catalog response and still appends a custom model', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('teapot', { status: 418 }));
    const models = await new ChatGptProvider({ ...cfg, customModelId: 'my-codex-model' }).listModels();
    expect(models.at(-1)).toMatchObject({ id: 'my-codex-model', name: 'my-codex-model (custom)' });
    expect(models.at(-1)?.contextLength).toBeUndefined();
  });

  it('listModels serves the curated set without a network call when signed out', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const models = await new ChatGptProvider({ ...cfg, apiKey: undefined }).listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('test() reports sign-in state and verifies against the catalog', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"models":[]}', { status: 200 }));
    expect(await new ChatGptProvider(cfg).test()).toEqual({
      ok: true,
      message: 'Signed in with a ChatGPT subscription',
    });
    expect((await new ChatGptProvider({ ...cfg, apiKey: undefined }).test()).ok).toBe(false);
    expect((await new ChatGptProvider({ ...cfg, accountId: undefined }).test()).message).toMatch(/sign in again/i);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('expired', { status: 401 }));
    expect(await new ChatGptProvider(cfg).test()).toEqual({ ok: false, message: 'chatgpt 401: expired' });
  });
});

describe('ChatGptProvider SSE parsing', () => {
  it('maps text, reasoning, tool call, and usage events to ProviderChunks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
        'data: {"type":"response.output_text.delta","delta":" world"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_9","name":"read_file","arguments":"{\\"path\\":\\"b.ts\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":7}}}\n\n',
      ]),
    );
    const chunks = await collect(new ChatGptProvider(cfg), { model: 'gpt-5-codex', messages: [] });
    expect(chunks).toEqual([
      { type: 'reasoning', delta: 'thinking ' },
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
      { type: 'tool_call', call: { id: 'call_9', name: 'read_file', input: { path: 'b.ts' } } },
      { type: 'usage', inputTokens: 10, outputTokens: 7, outputMs: expect.any(Number) },
      { type: 'done' },
    ]);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
  });

  it('stops on response.incomplete with usage and a single done', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.incomplete","response":{"usage":{"input_tokens":4,"output_tokens":2}}}\n\n',
      ]),
    );
    const chunks = await collect(new ChatGptProvider(cfg), { model: 'gpt-5-codex', messages: [] });
    expect(chunks).toEqual([
      { type: 'text', delta: 'partial' },
      { type: 'usage', inputTokens: 4, outputTokens: 2, outputMs: expect.any(Number) },
      { type: 'done' },
    ]);
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
  });

  it('throws when the stream reports response.failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"type":"response.failed","response":{"error":{"message":"ran out of room"}}}\n\n',
      ]),
    );
    await expect(collect(new ChatGptProvider(cfg), { model: 'gpt-5-codex', messages: [] })).rejects.toThrow(/ran out of room/);
  });

  it('throws when the stream reports an error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"type":"error","error":{"message":"model overloaded"}}\n\n',
      ]),
    );
    await expect(collect(new ChatGptProvider(cfg), { model: 'gpt-5-codex', messages: [] })).rejects.toThrow(/model overloaded/);
  });

  it('yields done exactly once in a completed stream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      sseResponse([
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      ]),
    );
    const chunks = await collect(new ChatGptProvider(cfg), { model: 'gpt-5-codex', messages: [] });
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(1);
    expect(chunks.at(-1)).toEqual({ type: 'done' });
  });

  it('throws on a non-OK response so a 401 triggers the host refresh path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(collect(new ChatGptProvider(cfg), { model: 'gpt-5-codex', messages: [] })).rejects.toThrow(/401/);
  });
});
