import type { ProviderConfig } from '@agent-nekko/shared';
import { createProvider, type ChatRequest } from '@agent-nekko/core';
import { daemonCall } from './engine/daemon.js';
import { daemonOwns } from './daemon-loop.js';

/** The request a one-shot completion sends: no tools, no signal, no hooks. */
export type CompleteRequest = Pick<ChatRequest, 'model' | 'messages' | 'temperature' | 'maxOutputTokens' | 'think' | 'purpose'>;

/**
 * Run one short completion beside a turn (a title, suggested replies, a
 * prompt part) and return its text. The engine daemon makes the call on its
 * Rust providers when it can (`provider:complete`, crates/nekkod/src/sideband.rs),
 * so the stream never shares this event loop with a running turn; otherwise
 * it runs here. `provider` must already be resolved (subscription token fresh).
 * Throws on a model or network failure, or once `timeoutMs` passes.
 */
export async function completeText(provider: ProviderConfig, request: CompleteRequest, timeoutMs = 30_000): Promise<string> {
  const daemon = process.env.NEKKO_AGENT_LOOP === 'ts' ? undefined : daemonCall();
  if (daemon && (await daemonOwns(daemon, 'provider:complete'))) {
    const out = await daemon<{ text?: string }>('provider:complete', { provider, request, timeoutMs });
    return out?.text ?? '';
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let out = '';
    for await (const chunk of createProvider(provider).chat({ ...request, signal: controller.signal })) {
      if (chunk.type === 'text') out += chunk.delta;
    }
    return out;
  } finally {
    clearTimeout(timeout);
  }
}
