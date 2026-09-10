import React, { useState } from 'react';
import type { Session } from '@agent-nekko/shared';
import { WarningIcon, CloseIcon } from '../icons.js';
import { useStore } from '../store.js';

/** Thresholds as fraction of the context window. */
const WARN_PCT = 70;
const CRITICAL_PCT = 85;

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
}: {
  sessionId: string;
  used: number;
  windowTokens: number;
  session: Session | null;
}) {
  const pct = windowTokens ? (used / windowTokens) * 100 : 0;
  const dismissedKey = `kotrain.ctxDismissed.${sessionId}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissedKey) !== null; } catch { return false; }
  });

  // Only render when the threshold is breached and hasn't been dismissed.
  if (pct < WARN_PCT || dismissed) return null;

  const isCritical = pct >= CRITICAL_PCT;
  const remaining = Math.max(0, windowTokens - used);
  const freePct = ((remaining / windowTokens) * 100).toFixed(0);

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(dismissedKey, '1'); } catch { /* best effort */ }
  };

  const openNewChat = async () => {
    // Create a new session under the same workspace (if any).
    const wsId = session?.workspaceId;
    const created = await window.kotrain.createSession(wsId ?? undefined);
    // Copy over provider/model if they were set on this session.
    if (session?.providerId || session?.modelId) {
      const opts: { providerId?: string; modelId?: string; autoModel?: boolean } = {};
      if (session.providerId) opts.providerId = session.providerId;
      if (session.autoModel) {
        opts.autoModel = true;
      } else if (session.modelId) {
        opts.modelId = session.modelId;
      }
      await window.kotrain.setSessionOptions(created.id, opts).catch(() => {});
    }
    // Copy over supporting workspaces
    if (session?.supportingWorkspaceIds?.length) {
      await window.kotrain.setSessionSupportingWorkspaces(created.id, session.supportingWorkspaceIds).catch(() => {});
    }
    useStore.getState().refreshSessions();
    useStore.getState().openChatPane(created.id);
  };

  const summarizeAndContinue = async () => {
    // Gather the conversation text for summarization.
    const messages = session?.messages ?? [];
    const convoText = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? 'You' : 'Kotrain'}: ${m.content}`)
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
    const created = await window.kotrain.createSession(wsId ?? undefined);

    // Copy over provider/model.
    if (session?.providerId || session?.modelId) {
      const opts: { providerId?: string; modelId?: string; autoModel?: boolean } = {};
      if (session.providerId) opts.providerId = session.providerId;
      if (session.autoModel) {
        opts.autoModel = true;
      } else if (session.modelId) {
        opts.modelId = session.modelId;
      }
      await window.kotrain.setSessionOptions(created.id, opts).catch(() => {});
    }
    if (session?.supportingWorkspaceIds?.length) {
      await window.kotrain.setSessionSupportingWorkspaces(created.id, session.supportingWorkspaceIds).catch(() => {});
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
            This conversation is using <span className="tabular-nums font-medium">{fmt(used)}</span> of{' '}
            <span className="tabular-nums">{fmt(windowTokens)}</span> tokens{' '}
            (<span className="tabular-nums">{Math.round(pct)}%</span>).{' '}
            {remaining > 0
              ? `About ${freePct}% free — replies may get shorter or lose detail soon.`
              : 'No room left for new replies.'}
          </p>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              className="btn btn-primary h-7 px-3 text-[11px]"
              onClick={openNewChat}
              title="Open a fresh chat with the same workspace, provider, and model"
            >
              New chat
            </button>
            <button
              className="btn btn-outline h-7 px-3 text-[11px]"
              onClick={summarizeAndContinue}
              title="Summarize this conversation and continue in a new chat"
            >
              Summarize & continue
            </button>
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
