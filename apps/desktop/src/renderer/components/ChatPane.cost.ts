import { estimateCost, type AgentEvent } from '@agent-nekko/shared';

/** Price measured usage separately from the in-flight token estimate. */
export function measuredUsageCost(model: string | undefined, usage: Extract<AgentEvent, { type: 'usage' }>): number {
  return estimateCost(model, {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  }) ?? 0;
}
