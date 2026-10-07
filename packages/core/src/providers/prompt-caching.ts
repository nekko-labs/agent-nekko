import type { ProviderConfig } from '@agent-nekko/shared';

/** Only the managed runtime may assert this capability; kind/URL alone is insufficient. */
export type CacheCapableProviderConfig = ProviderConfig & { managedCachePrompt?: boolean };

/** Missing counters stay missing: automatic caching is not proof of a hit. */
export function cacheUsage(usage: any, inputField: 'prompt_tokens' | 'input_tokens') {
  const details = usage[`${inputField}_details`];
  const read = tokenCount(details?.cached_tokens);
  const write = tokenCount(details?.cache_write_tokens);
  return {
    inputTokens: Math.max(0, (tokenCount(usage[inputField]) ?? 0) - (read ?? 0) - (write ?? 0)),
    ...(read === undefined ? {} : { cacheReadTokens: read }),
    ...(write === undefined ? {} : { cacheWriteTokens: write }),
  };
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Conservative documented text-model families; do not opt image/audio/live models in.
 * https://openrouter.ai/docs/guides/best-practices/prompt-caching#google-gemini
 * Off omits explicit markers, but cannot disable Google's implicit caching.
 */
export function geminiExplicitCacheModel(model: string): boolean {
  return /^~?google\/gemini-(?:2\.0-flash-001|2\.5-(?:pro|flash|flash-lite)|3(?:\.1)?-(?:pro|flash))(?:-(?:preview(?:-\d+(?:-\d+)*)?|latest))?(?::[^/]+)?$/.test(model);
}

/** Mark complete system text and the last reusable user text, without dropping context.
 * Gemini uses the last normal-message breakpoint and normalizes the entire system instruction.
 * Avoid assistant/tool blocks and leave the current message entirely unmarked.
 */
export function geminiCachePrefix(body: any) {
  const messages = body.messages;
  const mark = (message: any) => {
    if (typeof message.content === 'string' && message.content) message.content = [{ type: 'text', text: message.content }];
    if (Array.isArray(message.content)) {
      const block = [...message.content].reverse().find((block: any) => block.type === 'text' && typeof block.text === 'string' && block.text);
      if (block) block.cache_control = { type: 'ephemeral' };
    }
  };
  if (messages.length > 1 && ['system', 'developer'].includes(messages[0].role)) mark(messages[0]);
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === 'user') { mark(messages[i]); break; }
  }
  return body;
}

/** Three breakpoints maximum, all on reusable prefix, never on the current message. */
export function anthropicCachePrefix(body: any, enabled?: boolean) {
  if (enabled === false) return body;
  const mark = (block: any) => { block.cache_control = { type: 'ephemeral' }; };
  if (body.tools?.length) mark(body.tools[body.tools.length - 1]);
  if (typeof body.system === 'string' && body.system) body.system = [{ type: 'text', text: body.system }];
  if (Array.isArray(body.system) && body.system.length) mark(body.system[body.system.length - 1]);
  const previous = body.messages[body.messages.length - 2];
  if (typeof previous?.content === 'string' && previous.content) previous.content = [{ type: 'text', text: previous.content }];
  if (Array.isArray(previous?.content) && previous.content.length) mark(previous.content[previous.content.length - 1]);
  return body;
}
