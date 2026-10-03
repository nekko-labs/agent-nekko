import { useCallback, useEffect, useRef, useState } from 'react';

import { plainText } from '@/lib/markdown';
import { AUTO_MODEL_ID, Channels, type AskAnswer, type PendingInput, type Session } from '@/lib/protocol';
import { useStore } from '@/lib/store';
import { applyEvent, fromMessages, idleTurn, mergeLive, type LiveTurn } from '@/lib/transcript';
import { computers, onAgentEvent, remote } from '@/services/computers';
import type { ChatModel } from './types';

/** A turn can run for hours (long agent runs); don't time the request out. */
const TURN_TIMEOUT_MS = 12 * 60 * 60 * 1000;

/**
 * A chat that lives on the computer. The saved session is the source of
 * truth; while a turn runs, `agent:event`s fold into a live overlay, and the
 * session is re-read when the turn ends (or after a reconnect, in case events
 * were missed while the phone was asleep).
 */
export function useRemoteChat(sessionId: string): ChatModel {
  const conn = useStore(computers, (s) => s.conn);
  const defaults = useStore(computers, (s) => s.defaults);
  const computerName = useStore(computers, (s) => s.computers.find((c) => c.id === s.activeId)?.name ?? 'your computer');
  const [session, setSession] = useState<Session | null>(null);
  const [turn, setTurn] = useState<LiveTurn>(idleTurn);
  const [loadError, setLoadError] = useState<string>();
  const turnRef = useRef(turn);
  turnRef.current = turn;

  const reload = useCallback(async () => {
    try {
      const c = remote();
      const [s, pending] = await Promise.all([
        c.call<Session | null>(Channels.sessionGet, sessionId),
        c.call<Record<string, PendingInput>>(Channels.chatPending).catch(() => ({}) as Record<string, PendingInput>),
      ]);
      if (!s) {
        setLoadError('This chat was deleted on your computer.');
        return;
      }
      setSession(s);
      setLoadError(undefined);
      const mine = pending[sessionId];
      // Mid-turn the overlay keeps streaming; mergeLive hides what the re-read
      // session already holds. After the turn the session has it all.
      setTurn((t) => ({
        ...t,
        blocks: t.running ? t.blocks : [],
        approval: mine?.approval ? { call: mine.approval.call, reason: mine.approval.reason, severity: mine.approval.severity } : undefined,
        question: mine?.question,
        running: t.running || !!mine,
      }));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [sessionId]);

  // Load when the computer is reachable, and again after every reconnect.
  useEffect(() => {
    if (conn === 'online') void reload();
  }, [conn, reload]);

  useEffect(
    () =>
      onAgentEvent((e) => {
        if (e.sessionId !== sessionId) return;
        setTurn((t) => applyEvent(t, e));
        if (e.type === 'done' || e.type === 'error') {
          // Re-read the saved transcript, then drop the overlay it replaces.
          void reload();
        } else if (e.type === 'session_meta') {
          void reload();
        }
      }),
    [sessionId, reload],
  );

  const providerId = session?.providerId ?? defaults.defaultProviderId;
  const modelId = session?.modelId && session.modelId !== AUTO_MODEL_ID ? session.modelId : defaults.defaultModelId;

  const send = useCallback(
    async (text: string) => {
      const c = remote();
      if (turnRef.current.running) {
        // Same as the desktop: a prompt sent mid-run waits its turn.
        const s = await c.call<Session | null>(Channels.chatQueue, sessionId, text);
        if (s) setSession(s);
        return;
      }
      if (!providerId || !modelId) throw new Error('Choose a default model on your computer first.');
      setTurn({
        ...idleTurn(),
        running: true,
        blocks: [{ kind: 'user', id: `pending-${Date.now()}`, text, at: Date.now() }],
      });
      // Resolves only when the whole turn ends; the events carry the progress.
      c.callWithTimeout(TURN_TIMEOUT_MS, Channels.chatSend, { sessionId, providerId, modelId, text }).catch((err: Error) => {
        setTurn((t) => ({ ...t, running: false, error: err.message }));
      });
    },
    [sessionId, providerId, modelId],
  );

  const blocked =
    conn === 'denied'
      ? 'This phone is no longer paired.'
      : conn !== 'online'
        ? `${computerName} is ${conn === 'offline' ? 'offline' : 'reconnecting'}.`
        : !providerId || !modelId
          ? 'No model chosen for this chat. Set a default model on your computer.'
          : undefined;

  const saved = session ? fromMessages(session.messages) : [];

  return {
    ready: !!session || !!loadError,
    title: plainText(session?.title || '') || 'Chat',
    subtitle: [modelId, computerName].filter(Boolean).join(' · '),
    where: 'computer',
    blocks: mergeLive(saved, turn.blocks),
    running: turn.running,
    approval: turn.approval,
    question: turn.question,
    error: loadError ?? turn.error,
    blocked,
    queued: session?.queue,
    rate: turn.rate,
    send,
    stop: () => void remote().call(Channels.chatAbort, sessionId).catch(() => {}),
    approve: async (ok) => {
      const a = turnRef.current.approval;
      if (!a) return;
      setTurn((t) => ({ ...t, approval: undefined }));
      await remote().call(Channels.toolApprove, sessionId, a.call.id, ok);
    },
    answer: async (answers: AskAnswer[]) => {
      const q = turnRef.current.question;
      if (!q) return;
      setTurn((t) => ({ ...t, question: undefined }));
      await remote().call(Channels.chatAnswer, sessionId, q.callId, answers);
    },
  };
}
