import { createProvider, type Provider } from '@nekko-agent/core';
import { promptCachingEnabled, type ProviderConfig } from '@nekko-agent/shared';
import { getSettings } from './store.js';

let managedEndpoint: (() => string | undefined) | undefined;
/** Registered by the host's owned engine, never by settings or server discovery. */
export function registerManagedCacheEndpoint(endpoint: () => string | undefined): void {
  managedEndpoint = endpoint;
}
export function promptCachingForHost(): boolean {
  return promptCachingEnabled(getSettings());
}
export function hostProviderConfig(config: ProviderConfig): ProviderConfig {
  const { managedCachePrompt: ignored, ...safe } = config;
  const endpoint = managedEndpoint?.();
  return endpoint && config.kind === 'llamacpp' && config.baseUrl === endpoint
    ? { ...safe, managedCachePrompt: true }
    : safe;
}
/** Enforce the current host setting even for core loops predating the new option. */
export function createHostProvider(config: ProviderConfig, onCacheUsage?: (usage: { cacheReadTokens?: number; cacheWriteTokens?: number }) => void): Provider {
  const provider = createProvider(hostProviderConfig(config));
  return {
    config: provider.config,
    listModels: () => provider.listModels(),
    test: () => provider.test(),
    async *chat(request) {
      for await (const chunk of provider.chat({ ...request, promptCaching: promptCachingForHost() })) {
        if (chunk.type === 'usage') onCacheUsage?.(chunk);
        yield chunk;
      }
    },
  };
}
