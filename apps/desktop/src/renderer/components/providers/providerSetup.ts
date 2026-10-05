import type { ProviderConfig } from '@agent-nekko/shared';

/** The automatically registered engine is not a completed setup without a model. */
export function needsProviderSetup(providers: ProviderConfig[], modelId?: string | null): boolean {
  return !providers.some((p) => p.enabled && (p.kind !== 'llamacpp' || Boolean(modelId)));
}
