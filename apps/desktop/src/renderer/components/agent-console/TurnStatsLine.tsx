import type { TurnStats } from '@agent-nekko/shared';
import { formatRate, turnTokensPerSecond } from '@agent-nekko/shared';
import { fmtTok } from './transcript.js';

const EFFORT_LABEL: Record<NonNullable<TurnStats['effort']>, string> = {
  low: 'Low', medium: 'Medium', normal: 'Normal', high: 'High', xhigh: 'Extra high', max: 'Max',
};

/** Display names the transcript knows, so the line can name models rather than ids. */
export interface TurnStatsNames {
  provider?: (providerId: string) => string | undefined;
  model?: (providerId: string, modelId: string) => string | undefined;
}

/** The parts of the line, shared by the component and its tests. */
export function turnStatsParts(stats: TurnStats, names: TurnStatsNames = {}): string[] {
  const model = names.model?.(stats.providerId, stats.modelId) ?? stats.modelId;
  const provider = names.provider?.(stats.providerId);
  const tps = turnTokensPerSecond(stats);
  const parts = [provider ? `${model} · ${provider}` : model];
  if (stats.effort) parts.push(`${EFFORT_LABEL[stats.effort]} effort`);
  parts.push(`${fmtTok(stats.inputTokens + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0))} in`);
  parts.push(`${fmtTok(stats.outputTokens)} out`);
  if (tps > 0) parts.push(`${formatRate(tps)} tok/s`);
  parts.push(`${Math.max(1, Math.round(stats.wallMs / 1000))}s`);
  return parts;
}

/** Exact counts for the hover title. */
export function turnStatsTitle(stats: TurnStats): string {
  const cache = (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
  return [
    `Model: ${stats.modelId} (${stats.providerId})`,
    stats.effort ? `Effort: ${stats.effort}` : null,
    `Input: ${stats.inputTokens.toLocaleString()} new${cache ? ` + ${(stats.cacheReadTokens ?? 0).toLocaleString()} cache read + ${(stats.cacheWriteTokens ?? 0).toLocaleString()} cache write` : ''}`,
    `Output: ${stats.outputTokens.toLocaleString()}`,
    `${stats.calls} model call${stats.calls === 1 ? '' : 's'}${stats.steps ? `, ${stats.steps} tool step${stats.steps === 1 ? '' : 's'}` : ''}`,
  ].filter(Boolean).join('\n');
}

/**
 * A finished reply's measurements, kept in the transcript under the reply:
 * which model and effort produced it, what it read and wrote, how fast. Lets a
 * long chat show where the tokens went, and which stretch ran on which model.
 */
export function TurnStatsLine({ stats, names }: { stats: TurnStats; names?: TurnStatsNames }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-faint" data-turn-stats title={turnStatsTitle(stats)}>
      {turnStatsParts(stats, names).map((p, i) => <span key={i}>{i > 0 && '· '}{p}</span>)}
    </div>
  );
}
