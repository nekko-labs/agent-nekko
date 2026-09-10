import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import type { ProviderConfig } from '@agent-nekko/shared';

const apiKeyCfg: ProviderConfig = {
  id: 'p1',
  kind: 'anthropic',
  label: 'Claude',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
  enabled: true,
};

const subCfg: ProviderConfig = {
  ...apiKeyCfg,
  apiKey: 'oauth-access-token',
  auth: 'subscription',
  tokenKey: 'claude:acct',
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

const DONE_STREAM = ['data: {"type":"message_stop"}\n\n'];

async function runChat(cfg: ProviderConfig, system?: string) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(DONE_STREAM));
  for await (const _ of new AnthropicProvider(cfg).chat({ model: 'claude-sonnet-4-6', messages: [], system })) {
    /* drain */
  }
  const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
  return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
}

afterEach(() => vi.restoreAllMocks());

describe('AnthropicProvider subscription auth', () => {
  it('sends x-api-key in API-key mode, unchanged', async () => {
    const { headers, body } = await runChat(apiKeyCfg, 'be terse');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(body.system).toBe('be terse');
  });

  it('sends a Bearer token plus the oauth beta header in subscription mode', async () => {
    const { headers } = await runChat(subCfg, 'be terse');
    expect(headers.Authorization).toBe('Bearer oauth-access-token');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('prepends the Claude Code identity block ahead of the real system prompt', async () => {
    const { body } = await runChat(subCfg, 'You are a coding agent.');
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].text).toContain('Claude Code');
    expect(body.system[1].text).toBe('You are a coding agent.');
  });

  it('still sends the required prefix when the request has no system prompt', async () => {
    const { body } = await runChat(subCfg);
    expect(body.system).toHaveLength(1);
    expect(body.system[0].text).toContain('Claude Code');
  });

  it('test() reports subscription sign-in state', async () => {
    expect(await new AnthropicProvider(subCfg).test()).toEqual({
      ok: true,
      message: 'Signed in with a Claude subscription',
    });
    const signedOut = await new AnthropicProvider({ ...subCfg, apiKey: undefined }).test();
    expect(signedOut.ok).toBe(false);
    expect(signedOut.message).toMatch(/sign in/i);
  });
});
