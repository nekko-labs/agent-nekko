import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { cacheUsage, geminiExplicitCacheModel, type CacheCapableProviderConfig } from './prompt-caching.js';
import type { ChatRequest, ProviderChunk } from './types.js';

const config: CacheCapableProviderConfig = {
  id: 'cache-test', kind: 'anthropic', label: 'test', enabled: true, baseUrl: 'https://example.test',
};
const golden = join(__dirname, '../../../../crates/nekko-agent/tests/golden');
const fixtures = JSON.parse(readFileSync(join(golden, 'request-cases.json'), 'utf8')).requests;
const request: ChatRequest = fixtures['cache-default'];
async function drain(stream: AsyncIterable<ProviderChunk>) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
function mockStream(body = '') {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
}
function payload(spy: ReturnType<typeof mockStream>, index = 0) {
  return JSON.parse(spy.mock.calls[index][1]!.body as string);
}
function withoutCache(value: any): any {
  if (Array.isArray(value)) return value.map(withoutCache);
  if (!value || typeof value !== 'object') return value;
  const out: any = {};
  for (const [key, v] of Object.entries(value)) if (key !== 'cache_control') out[key] = withoutCache(v);
  // Native Anthropic string content is equivalent to a single text block.
  for (const key of ['content', 'system']) {
    if (Array.isArray(out[key]) && out[key].length === 1 && out[key][0].type === 'text') out[key] = out[key][0].text;
  }
  return out;
}
afterEach(() => vi.restoreAllMocks());

describe('native prompt caching', () => {
  it('only opts documented Gemini text families in', () => {
    for (const model of ['google/gemini-2.0-flash-001', 'google/gemini-2.5-pro', '~google/gemini-2.5-flash-lite', 'google/gemini-3-pro-preview:free', 'google/gemini-3.1-pro-preview', 'google/gemini-2.5-flash-preview-09-2025']) expect(geminiExplicitCacheModel(model)).toBe(true);
    for (const model of ['google/gemini-2.0-flash-lite', 'google/gemini-2.5-flash-image', 'google/gemini-2.5-flash-preview-image', 'google/gemini-2.5-flash-preview-tts', 'google/gemini-3-pro-image-preview', 'google/gemini-99-pro', 'openrouter/auto']) expect(geminiExplicitCacheModel(model)).toBe(false);
  });

  it('Gemini preserves multimodal context and only marks reusable text', async () => {
    const spy = mockStream();
    const req = { ...fixtures.images, model: 'google/gemini-2.5-pro', system: 'Stable system' };
    await drain(new OpenAICompatProvider({ ...config, kind: 'openrouter' }).chat(req));
    await drain(new OpenAICompatProvider({ ...config, kind: 'openrouter' }).chat({ ...req, promptCaching: false }));
    const on = payload(spy);
    expect(withoutCache(on)).toEqual(withoutCache(payload(spy, 1)));
    expect(JSON.stringify(on.messages.at(-1))).not.toContain('cache_control');
    for (const message of on.messages) for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.cache_control) expect(block.type).toBe('text');
    }
  });
  it('keeps complete system/tools/history, never mutates input or memoizes answers', async () => {
    const original = JSON.stringify(request);
    const spy = mockStream();
    const provider = new AnthropicProvider(config);
    for (const promptCaching of [undefined, true, false]) await drain(provider.chat({ ...request, promptCaching }));
    expect(spy).toHaveBeenCalledTimes(3);
    const on = payload(spy);
    const off = payload(spy, 2);
    expect(on).toEqual(payload(spy, 1));
    expect(withoutCache(on)).toEqual(withoutCache(off));
    expect(JSON.stringify(off)).not.toContain('cache_control');
    expect(JSON.stringify(on).match(/cache_control/g)).toHaveLength(3);
    expect(on.tools.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(on.system.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(on.messages.at(-2).content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(on.messages.at(-1))).not.toContain('cache_control');
    expect(on.messages).toHaveLength(off.messages.length);
    expect(JSON.stringify(request)).toBe(original);
  });

  it('preserves multimodal and tool-result blocks with a bounded prefix breakpoint', async () => {
    const spy = mockStream();
    const req: ChatRequest = { ...fixtures.images, promptCaching: true };
    await drain(new AnthropicProvider(config).chat(req));
    await drain(new AnthropicProvider(config).chat({ ...req, promptCaching: false }));
    expect(withoutCache(payload(spy))).toEqual(withoutCache(payload(spy, 1)));
    expect(JSON.stringify(payload(spy)).match(/cache_control/g)).toHaveLength(1);
  });

  it('opts routed Claude into caching without altering any context, gated by kind and model', async () => {
    const spy = mockStream();
    for (const kind of ['openrouter', 'openai', 'openai-compat', 'lmstudio', 'vllm', 'llamacpp'] as const) {
      for (const model of ['anthropic/claude-sonnet-4.5', '~anthropic/claude-sonnet-latest', 'anthropic/claude-sonnet-4.5:thinking', 'anthropic/claude-', 'anthropic/not-claude', 'claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'google/gemini-2.0-flash-001', 'openrouter/auto']) {
        const req = { ...request, model };
        const original = JSON.stringify(req);
        const bodies = [];
        for (const promptCaching of [undefined, true, false]) {
          await drain(new OpenAICompatProvider({ ...config, kind }).chat({ ...req, promptCaching }));
          bodies.push(payload(spy, spy.mock.calls.length - 1));
        }
        const supported = kind === 'openrouter' && /^~?anthropic\/claude-.+/.test(model);
        expect(bodies[0]).toEqual(bodies[1]);
        expect(withoutCache(bodies[0])).toEqual(withoutCache(bodies[2]));
        if (supported) expect(bodies[0].cache_control).toEqual({ type: 'ephemeral' });
        else if (kind === 'openrouter' && geminiExplicitCacheModel(model)) {
          expect(bodies[0].messages[0].content.at(-1).cache_control).toEqual({ type: 'ephemeral' });
          expect(JSON.stringify(bodies[0].messages.at(-1))).not.toContain('cache_control');
        } else expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
        expect(JSON.stringify(bodies[2])).not.toContain('cache_control');
        expect(withoutCache(bodies[0].messages)).toEqual(withoutCache(bodies[2].messages));
        expect(bodies[0].tools).toEqual(bodies[2].tools);
        expect(JSON.stringify(req)).toBe(original);
      }
    }
  });

  it('requires explicit managed llama.cpp capability; off sends cache_prompt false', async () => {
    const spy = mockStream();
    for (const kind of ['llamacpp', 'lmstudio', 'vllm', 'openai-compat', 'openai', 'openrouter'] as const) {
      for (const managedCachePrompt of [undefined, false, true]) {
        for (const promptCaching of [undefined, true, false]) {
          await drain(new OpenAICompatProvider({ ...config, kind, managedCachePrompt }).chat({ ...request, promptCaching }));
          const body = payload(spy, spy.mock.calls.length - 1);
          if (kind === 'llamacpp' && managedCachePrompt === true) {
            expect(body).toHaveProperty('cache_prompt', promptCaching !== false);
          } else {
            expect(body).not.toHaveProperty('cache_prompt');
          }
        }
      }
    }
  });

  it('reports automatic counters even when explicit caching is off, without inventing missing counters', async () => {
    const spy = mockStream('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":60,"cache_write_tokens":10}}}\n\ndata: [DONE]\n\n');
    const chunks = await drain(new OpenAICompatProvider({ ...config, kind: 'openrouter' }).chat({ ...request, promptCaching: false }));
    expect(chunks[0]).toMatchObject({ type: 'usage', inputTokens: 30, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 });
    expect(payload(spy)).not.toHaveProperty('cache_prompt');
    expect(cacheUsage({ prompt_tokens: 100 }, 'prompt_tokens')).toEqual({ inputTokens: 100 });
    expect(cacheUsage({ input_tokens: 10, input_tokens_details: { cached_tokens: 99 } }, 'input_tokens'))
      .toEqual({ inputTokens: 0, cacheReadTokens: 99 });
    expect(cacheUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: -1, cache_write_tokens: '5' } }, 'prompt_tokens'))
      .toEqual({ inputTokens: 10 });
  });

  it('keeps Anthropic noncached input separate from cache read/write', async () => {
    mockStream('data: {"type":"message_start","message":{"usage":{"input_tokens":30,"cache_read_input_tokens":60,"cache_creation_input_tokens":10}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\ndata: {"type":"message_stop"}\n\n');
    const chunks = await drain(new AnthropicProvider(config).chat({ ...request, promptCaching: false }));
    expect(chunks[0]).toMatchObject({ type: 'usage', inputTokens: 30, outputTokens: 5, cacheReadTokens: 60, cacheWriteTokens: 10 });
  });
});
