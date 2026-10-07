import type { LiveRun } from '../../liveRuns.js';

/** A provisional current-call rate; completed usage remains authoritative. */
export function liveTokenRate(run: LiveRun | undefined): { rate: number } | null {
  const generation = run?.generation;
  if (!generation) return null;
  const ms = generation.lastAt - generation.startedAt;
  // One chunk has no measurable interval. A short window is too noisy to show.
  if (ms < 100 || generation.chars <= 0) return null;
  // Same four-characters-per-token approximation used for live output estimates.
  return { rate: Math.ceil(generation.chars / 4) * 1000 / ms };
}
