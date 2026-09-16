import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  AnthropicProvider,
  isSamplingParamError,
  rejectsSampling,
  resetLearnedSampling,
} from './anthropic.js';
import type { EffortLevel, ProviderConfig } from '@agent-nekko/shared';

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

async function runChat(
  cfg: ProviderConfig,
  system?: string,
  extra: { model?: string; effort?: EffortLevel } = {},
) {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(DONE_STREAM));
  const chat = new AnthropicProvider(cfg).chat({
    model: extra.model ?? 'claude-sonnet-4-6',
    messages: [],
    system,
    temperature: 0.7,
    effort: extra.effort,
  });
  for await (const _ of chat) {
    /* drain */
  }
  // The last call, not the first: a test that runs two chats re-spies on the
  // same mock, so the calls accumulate.
  const [url, init] = spy.mock.calls[spy.mock.calls.length - 1] as unknown as [string, RequestInit];
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

  it('sends an effort level instead of a temperature on models that dropped sampling', async () => {
    const { body } = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5', effort: 'normal' });
    expect(body.temperature).toBeUndefined();
    expect(body.output_config).toEqual({ effort: 'high' });
  });

  it('maps the low and high effort settings to the ends of the range', async () => {
    const low = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5', effort: 'low' });
    expect(low.body.output_config).toEqual({ effort: 'low' });
    const high = await runChat(apiKeyCfg, undefined, { model: 'claude-opus-5', effort: 'high' });
    expect(high.body.output_config).toEqual({ effort: 'max' });
  });

  it('still sends a temperature to models that accept one', async () => {
    const { body } = await runChat(apiKeyCfg, undefined, { model: 'claude-sonnet-4-6', effort: 'normal' });
    expect(body.temperature).toBe(0.7);
    expect(body.output_config).toBeUndefined();
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

describe('rejectsSampling', () => {
  it('rejects sampling from the 4.7 generation onwards', () => {
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-opus-6']) {
      expect(rejectsSampling(m), m).toBe(true);
    }
  });

  it('rejects sampling on every Fable and Mythos model', () => {
    expect(rejectsSampling('claude-fable-5-1')).toBe(true);
    expect(rejectsSampling('claude-mythos-5-1')).toBe(true);
  });

  it('keeps sampling on 4.6 and older, including dated ids', () => {
    for (const m of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-3-5-sonnet-20241022']) {
      expect(rejectsSampling(m), m).toBe(false);
    }
  });

  it('reads a Claude name through a proxy prefix', () => {
    // This used to fall through to the sampling path, on the reasoning that a
    // proxy might serve something else under that name. In practice it serves
    // exactly what it says, and a wrong guess cost the user a 400. Reading the
    // name is the better bet now that a wrong guess is recovered rather than
    // fatal.
    expect(rejectsSampling('my-proxy/claude-opus-5')).toBe(true);
    expect(rejectsSampling('my-proxy/claude-sonnet-4-6')).toBe(false);
  });

  it('leaves a name it cannot parse at all on the sampling path', () => {
    expect(rejectsSampling('some-finetune-v2')).toBe(false);
    expect(rejectsSampling('')).toBe(false);
  });
});

describe('sampling parameter recovery', () => {
  beforeEach(() => resetLearnedSampling());

  /** A 400 in Anthropic's error shape. */
  const samplingError = (message: string) =>
    new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }), {
      status: 400,
    });

  const drain = async (it: AsyncIterable<unknown>) => {
    const out = [];
    for await (const c of it) out.push(c);
    return out;
  };

  const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string);

  it('retries without the temperature when the model rejects it, and remembers', async () => {
    // The exact failure a user hit: a model our version rule read as still
    // sampling, which the API says is past that.
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('`temperature` is deprecated for this model.'))
      .mockResolvedValue(sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));

    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-4-6', messages: [], system: '' } as never));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[0])).toHaveProperty('temperature');
    const retry = bodyOf(fetchMock.mock.calls[1]);
    expect(retry.temperature).toBeUndefined();
    expect(retry.output_config).toEqual({ effort: 'high' });

    // The next turn is right the first time: the API's answer outranks the guess.
    expect(rejectsSampling('claude-opus-4-6')).toBe(true);
  });

  it('retries the other way when a model rejects the effort knob', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(samplingError('`output_config` is not supported for this model.'))
      .mockResolvedValue(sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));

    const provider = new AnthropicProvider(apiKeyCfg);
    await drain(provider.chat({ model: 'claude-opus-5', messages: [], system: '' } as never));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock.mock.calls[1])).toHaveProperty('temperature');
    expect(rejectsSampling('claude-opus-5')).toBe(false);
  });

  it('does not retry a 400 that is about something else', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(samplingError('max_tokens: must be greater than 0'));

    const provider = new AnthropicProvider(apiKeyCfg);
    await expect(drain(provider.chat({ model: 'claude-opus-5', messages: [], system: '' } as never))).rejects.toThrow(
      /anthropic 400/,
    );
    // One attempt: retrying a real failure just produces the same error twice.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a vendor-prefixed id, which the anchored rule would have missed', () => {
    expect(rejectsSampling('anthropic/claude-opus-5')).toBe(true);
    expect(rejectsSampling('anthropic/claude-sonnet-4-6')).toBe(false);
  });
});

describe('isSamplingParamError', () => {
  it('names the parameter the API objected to', () => {
    expect(isSamplingParamError(400, '`temperature` is deprecated for this model.')).toBe('temperature');
    expect(isSamplingParamError(400, 'top_p: unsupported parameter')).toBe('temperature');
    expect(isSamplingParamError(400, '`output_config` is not supported')).toBe('effort');
  });

  it('ignores anything that is not a 400 about a sampling parameter', () => {
    expect(isSamplingParamError(429, '`temperature` is deprecated')).toBeNull();
    expect(isSamplingParamError(400, 'credit balance is too low')).toBeNull();
    // A model *name* containing the word must not be mistaken for a complaint.
    expect(isSamplingParamError(400, 'model `temperature-test` not found')).toBeNull();
  });
});
