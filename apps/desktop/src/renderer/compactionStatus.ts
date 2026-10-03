import { create } from 'zustand';
import type { AgentEvent, CompactionProgress } from '@agent-nekko/shared';

/**
 * Each chat's latest compaction progress, from the host's `compaction` events.
 *
 * Kept app-wide rather than in the chat's banner: a compaction outlives the
 * pane that started it (switch chats and back, and the banner remounts), and
 * the banner has to pick up where the run actually is rather than start over.
 */
interface CompactionState {
  bySession: Record<string, CompactionProgress>;
  set: (sessionId: string, progress: CompactionProgress | undefined) => void;
}

export const useCompactionStore = create<CompactionState>((set) => ({
  bySession: {},
  set: (sessionId, progress) =>
    set((state) => {
      const next = { ...state.bySession };
      if (progress) next[sessionId] = progress;
      else delete next[sessionId];
      return { bySession: next };
    }),
}));

/** A chat's compaction progress, or undefined when none has run this launch. */
export function useCompaction(sessionId: string): CompactionProgress | undefined {
  return useCompactionStore((s) => s.bySession[sessionId]);
}

/** Forget a finished compaction, so its banner state does not linger. */
export function clearCompaction(sessionId: string): void {
  useCompactionStore.getState().set(sessionId, undefined);
}

/** Fold `compaction` events for the whole app. Called once, at launch. */
export function startCompactionStatus(): () => void {
  return window.nekko.onAgentEvent((e: AgentEvent) => {
    if (e.type === 'compaction') useCompactionStore.getState().set(e.sessionId, e.progress);
  });
}

/** "Summarizing 2 of 5" style progress text, and the 0..1 fraction behind it. */
export function describeProgress(p: CompactionProgress): { label: string; fraction: number } {
  if (p.total <= 0) return { label: 'Preparing the transcript…', fraction: 0 };
  const fraction = Math.min(1, p.done / p.total);
  return { label: `Summarizing part ${Math.min(p.done + 1, p.total)} of ${p.total}`, fraction };
}
