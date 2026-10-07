import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatProvider } from './openai-compat.js';
import { OllamaProvider } from './ollama.js';

afterEach(() => vi.restoreAllMocks());
const config = { id: 'local', kind: 'openai-compat' as const, label: 'Local fixture', baseUrl: 'http://localhost:9999', enabled: true };
const request = { model: 'small-fixture', messages: [] };
async function collect(provider: OpenAICompatProvider | OllamaProvider) {
  const chunks = [];
  for await (const chunk of provider.chat(request)) chunks.push(chunk);
  return chunks;
}
describe('local model streaming', () => {
  it('delivers OpenAI-compatible replies framed with CRLF', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'));
    expect(await collect(new OpenAICompatProvider(config))).toContainEqual({ type: 'text', delta: 'Hello' });
  });
  it('surfaces OpenAI-compatible in-stream errors instead of ending silently', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('data: {"error":{"message":"Model could not load"}}\n\n'));
    await expect(collect(new OpenAICompatProvider(config))).rejects.toThrow('Model could not load');
  });
  it('surfaces Ollama in-stream errors instead of ending silently', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"model does not support tools"}\n'));
    await expect(collect(new OllamaProvider({ ...config, kind: 'ollama' }))).rejects.toThrow('model does not support tools');
  });
});
