import type { ProviderConfig } from '@agent-nekko/shared';
import { DISCOVERY_TARGETS } from '@agent-nekko/shared';
import type { Provider } from './types.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import { ChatGptProvider } from './chatgpt.js';
import { OllamaProvider } from './ollama.js';

export * from './types.js';
export { OpenAICompatProvider } from './openai-compat.js';
export { AnthropicProvider } from './anthropic.js';
export { ChatGptProvider } from './chatgpt.js';
export { OllamaProvider } from './ollama.js';

/** Build a Provider instance from its stored config. */
export function createProvider(config: ProviderConfig): Provider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai':
    case 'openrouter':
    case 'lmstudio':
    case 'vllm':
    case 'openai-compat':
      return new OpenAICompatProvider(config);
    case 'chatgpt':
      return new ChatGptProvider(config);
  }
}

/**
 * Probe well-known localhost ports for running model servers. Returns a
 * ProviderConfig for each one that responds, so the UI can offer one-click add.
 */
export async function discoverLocalProviders(timeoutMs = 1500): Promise<ProviderConfig[]> {
  const found: ProviderConfig[] = [];
  await Promise.all(
    DISCOVERY_TARGETS.map(async (t) => {
      // Try IPv4 first: on Windows `localhost` frequently resolves to IPv6 `::1`
      // while local model servers (LM Studio/Ollama/vLLM) bind only IPv4, so a
      // bare-`localhost` probe gets refused and we'd miss a running server.
      const hosts = ['127.0.0.1', 'localhost'];
      for (const h of hosts) {
        const base = t.baseUrl.replace(/127\.0\.0\.1|localhost/, h);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(`${base}${t.probe}`, { signal: ctrl.signal });
          if (res.ok) {
            found.push({
              id: `${t.kind}-local`,
              kind: t.kind,
              label: `${t.kind} (local)`,
              baseUrl: base,
              discovered: true,
              enabled: true,
            });
            return; // first reachable host wins
          }
        } catch {
          /* not running on this host */
        } finally {
          clearTimeout(timer);
        }
      }
    }),
  );
  return found;
}
