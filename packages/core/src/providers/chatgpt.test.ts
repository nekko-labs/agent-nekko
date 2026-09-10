import { describe, it, expect, vi, afterEach } from 'vitest';
import { ChatGptProvider } from './chatgpt.js';
import type { ProviderConfig } from '@agent-nekko/shared';
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
  const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
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
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file body' },
    ]);
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
    ]);
  });

  it('throws a sign-in-again error when the account id is missing', async () => {
    const noAccount = new ChatGptProvider({ ...cfg, accountId: undefined });
    const spy = vi.spyOn(globalThis, 'fetch');
    await expect(collect(noAccount, { model: 'gpt-5-codex', messages: [] })).rejects.toThrow(/sign in again/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('listModels returns the curated ChatGPT-plan set without a network call', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const models = await new ChatGptProvider(cfg).listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.providerId === 'p1')).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('test() reports sign-in state', async () => {
    expect(await new ChatGptProvider(cfg).test()).toEqual({
      ok: true,
      message: 'Signed in with a ChatGPT subscription',
    });
    expect((await new ChatGptProvider({ ...cfg, apiKey: undefined }).test()).ok).toBe(false);
    expect((await new ChatGptProvider({ ...cfg, accountId: undefined }).test()).message).toMatch(/sign in again/i);
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
