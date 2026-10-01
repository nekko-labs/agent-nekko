import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@agent-nekko/shared';
import { WarningIcon, CloseIcon } from '../icons.js';
import { useStore } from '../store.js';

/** Thresholds as fraction of the context window. */
const WARN_PCT = 95;
const CRITICAL_PCT = 99;

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/**
 * In-chat banner shown when the conversation is eating too much of the context
 * window. Offers two escape hatches:
 *  1. Open a fresh chat with the same settings (workspace, provider, model).
 *  2. Summarize this conversation and seed a new chat with the summary so the
 *     next agent picks up where this one left off.
 *
 * Dismissible per-session (localStorage) so it doesn't nag on every render.
 */
export function ContextWarning({
  sessionId,
  used,
  windowTokens,
  session,
  streaming,
  onCompacted,
}: {
  sessionId: string;
  used: number;
  windowTokens: number;
  session: Session | null;
  streaming: boolean;
  onCompacted: () => void;
}) {
  const pct = windowTokens ? (used / windowTokens) * 100 : 0;
  const dismissedKey = `nekko.ctxDismissed.${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissedKey) !== null; } catch { return false; }
  });
  const [compaction, setCompaction] = useState<'idle' | 'running' | 'failed' | 'done'>('idle');
  const [compactionError, setCompactionError] = useState('');
  const autoStarted = useRef(false);
  const cancelled = useRef(false);

  const startCompaction = useCallback(async () => {
    if (compaction === 'running') return;
    cancelled.current = false;
    setCompactionError('');
    setCompaction('running');
    try {
      await window.nekko.compactSession(sessionId);
      setCompaction('done');
      onCompacted();
      void useStore.getState().refreshSessions().catch(() => {});
    } catch (error) {
      if (!cancelled.current) {
        setCompactionError((error as Error).message || 'Compaction failed.');
        setCompaction('failed');
      }
    }
  }, [compaction, onCompacted, sessionId]);

  useEffect(() => {
    if (pct < WARN_PCT) {
      autoStarted.current = false;
      if (compaction === 'done') setCompaction('idle');
      return;
    }
    if (streaming || session?.incognito || session?.queue?.length || !session?.messages.length || autoStarted.current) return;
    autoStarted.current = true;
    void startCompaction();
  }, [pct >= WARN_PCT, streaming, session?.incognito, session?.queue?.length, session?.messages.length, compaction, startCompaction]);

  if (pct < WARN_PCT || (dismissed && compaction !== 'running')) return null;

  const isCritical = pct >= CRITICAL_PCT;
  const remaining = Math.max(0, windowTokens - used);
  const freePct = ((remaining / windowTokens) * 100).toFixed(0);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissedKey, '1'); } catch { /* best effort */ }
  };

  const openNewChat = async () => {
    if (compaction === 'running') {
      cancelled.current = true;
      await window.nekko.cancelSessionCompaction(sessionId).catch(() => {});
    }
    // Create a new session under the same workspace (if any).
    const wsId = session?.workspaceId;
    const created = await window.nekko.createSession(wsId ?? undefined);
    // Copy over provider/model if they were set on this session.
    if (session?.providerId || session?.modelId) {
      const opts: { providerId?: string; modelId?: string; autoModel?: boolean } = {};
      if (session.providerId) opts.providerId = session.providerId;
      if (session.autoModel) {
        opts.autoModel = true;
      } else if (session.modelId) {
        opts.modelId = session.modelId;
      }
      await window.nekko.setSessionOptions(created.id, opts).catch(() => {});
    }
    // Copy over supporting workspaces
    if (session?.supportingWorkspaceIds?.length) {
      await window.nekko.setSessionSupportingWorkspaces(created.id, session.supportingWorkspaceIds).catch(() => {});
    }
    useStore.getState().refreshSessions();
    useStore.getState().openChatPane(created.id);
  };

  const summarizeAndContinue = async () => {
    // Gather the conversation text for summarization.
    const messages = session?.messages ?? [];
    const convoText = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? 'You' : 'Nekko'}: ${m.content}`)
      .join('\n\n');

    if (!convoText.trim()) return;

    // Build a summarization prompt.
    const summaryPrompt = [
      'Please summarize the following conversation concisely (3-6 bullet points).',
      'Focus on: what was accomplished, key decisions, and what\'s next.',
      '',
      '--- Conversation ---',
      convoText,
      '--- End ---',
      '',
      'Summary:',
    ].join('\n');

    // Create a new session and send the summary request.
    const wsId = session?.workspaceId;
    const created = await window.nekko.createSession(wsId ?? undefined);

    // Copy over provider/model.
    if (session?.providerId || session?.modelId) {
      const opts: { providerId?: string; modelId?: string; autoModel?: boolean } = {};
      if (session.providerId) opts.providerId = session.providerId;
      if (session.autoModel) {
        opts.autoModel = true;
      } else if (session.modelId) {
        opts.modelId = session.modelId;
      }
      await window.nekko.setSessionOptions(created.id, opts).catch(() => {});
    }
    if (session?.supportingWorkspaceIds?.length) {
      await window.nekko.setSessionSupportingWorkspaces(created.id, session.supportingWorkspaceIds).catch(() => {});
    }

    await useStore.getState().refreshSessions();
    useStore.getState().openChatPane(created.id);

    // Seed the new chat's composer with the summary prompt so the user can
    // review/edit before sending.
    useStore.getState().sendToChat(summaryPrompt, false);
  };

  return (
    <div
      className={`fade-in mx-auto w-full max-w-3xl rounded-xl border px-4 py-3 text-[12px] ${
        isCritical
          ? 'border-(--danger)/30'
          : 'border-line'
      }`}
      style={{
        background: isCritical
          ? 'color-mix(in srgb, var(--danger) 6%, transparent)'
          : 'var(--surface-2)',
      }}
      role="alert"
    >
      <div className="flex items-start gap-2.5">
        <WarningIcon className={`shrink-0 h-4 w-4 mt-0.5 ${isCritical ? 'text-(--danger)' : 'text-ink-faint'}`} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">
            Context window is getting full
          </p>
          <p className="mt-0.5 text-ink-soft">
            Estimated prompt size: <span className="tabular-nums font-medium">{fmt(used)}</span> of{' '}
            <span className="tabular-nums">{fmt(windowTokens)}</span> tokens{' '}
            (<span className="tabular-nums">{Math.round(pct)}%</span>).{' '}
            {compaction === 'running'
              ? 'Summarizing older conversation to continue in this session.'
              : streaming && compaction === 'idle'
                ? 'Automatic compaction will start after this reply finishes.'
                : compaction === 'done'
                ? 'Conversation compacted; the same session is ready to continue.'
                : compaction === 'failed'
                  ? `Automatic compaction failed: ${compactionError}`
                  : remaining > 0
                  ? `About ${freePct}% estimated headroom; actual provider usage can differ.`
                  : 'The estimate exceeds the listed window. Provider token accounting can differ; if replies still work, this is not a hard limit.'}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            {compaction === 'running' ? (
              <button
                className="btn btn-primary h-7 px-3 text-[11px]"
                onClick={openNewChat}
                title="Cancel compaction and open a fresh chat with the same workspace, provider, and model"
              >
                Move to new chat
              </button>
            ) : (
              <>
                <button
                  className="btn btn-primary h-7 px-3 text-[11px]"
                  onClick={openNewChat}
                  title="Open a fresh chat with the same workspace, provider, and model"
                >
                  New chat
                </button>
                {(compaction === 'failed' || compaction === 'done') && (
                  <button className="btn btn-outline h-7 px-3 text-[11px]" onClick={() => void startCompaction()}>
                    {compaction === 'failed' ? 'Retry compaction' : 'Compact again'}
                  </button>
                )}
                <button
                  className="btn btn-outline h-7 px-3 text-[11px]"
                  onClick={summarizeAndContinue}
                  title="Summarize this conversation and continue in a new chat"
                >
                  Summarize & continue
                </button>
              </>
            )}
          </div>
        </div>
        <button
          className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          title="Dismiss"
          onClick={dismiss}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
