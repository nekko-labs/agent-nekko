/**
 * Desktop notifications for chats you are not looking at.
 *
 * Four agents running in four windows, or one running while you read mail:
 * the moment that matters is when one finishes, fails, or stops to ask, and
 * that moment used to be visible only in the pane itself. This posts an OS
 * notification for those events when the window is hidden or unfocused, or
 * the chat is not the one on screen; clicking it brings the window and that
 * chat forward. The phone gets the same through the relay's push; this is
 * the desktop counterpart (Claude Code's notification hook, Codex `notify`).
 *
 * `decideNotification` is pure and tested; `startDesktopNotifications` wires
 * it to the event stream and the Notification API.
 */

import type { AgentEvent } from '@nekko-agent/shared';
import { summarizeAsk } from '@nekko-agent/shared';
import { useStore } from './store.js';

export interface NotificationContext {
  /** Whether notifications are enabled in Settings. */
  enabled: boolean;
  /** The window is hidden, minimized or behind another app. */
  windowHidden: boolean;
  /** The chat whose pane is on screen, if the chat view is showing. */
  visibleSessionId: string | null;
  /** The chat's title, for the body. */
  titleOf: (sessionId: string) => string | undefined;
}

export interface Notice {
  sessionId: string;
  kind: 'finished' | 'failed' | 'question' | 'approval';
  title: string;
  body: string;
}

/** Events that are not failures, just the user pressing Stop. */
const STOPS = new Set(['Stopped', 'Aborted', 'This operation was aborted']);

/** What, if anything, to tell the user about an event. Pure. */
export function decideNotification(event: AgentEvent, ctx: NotificationContext): Notice | null {
  if (!ctx.enabled) return null;
  if ((event as { relayOnly?: boolean }).relayOnly) return null;
  // A chat on screen in a focused window needs no toast; its pane shows it.
  if (!ctx.windowHidden && ctx.visibleSessionId === event.sessionId) return null;
  const chat = ctx.titleOf(event.sessionId)?.trim() || 'A chat';
  switch (event.type) {
    case 'done':
      return { sessionId: event.sessionId, kind: 'finished', title: 'Reply finished', body: chat };
    case 'error':
      if (STOPS.has(event.message.trim())) return null;
      return { sessionId: event.sessionId, kind: 'failed', title: 'Reply failed', body: `${chat}: ${event.message.slice(0, 120)}` };
    case 'question':
      return { sessionId: event.sessionId, kind: 'question', title: 'Nekko Agent has a question', body: `${chat}: ${summarizeAsk(event.request).slice(0, 120)}` };
    case 'tool_approval_required':
      return { sessionId: event.sessionId, kind: 'approval', title: 'Approval needed', body: `${chat}: ${event.reason || event.call.name}` };
    default:
      return null;
  }
}

/** The same notice is not repeated within this window (a retry storm, a double event). */
const DEDUPE_MS = 5_000;

/**
 * Listen for the whole app. Returns the unsubscribe. Permission is asked once,
 * the first time a notice is due, so a user who never leaves a chat unattended
 * is never prompted.
 */
export function startDesktopNotifications(): () => void {
  if (typeof Notification === 'undefined') return () => {};
  const recent = new Map<string, number>();
  let shown: Notification[] = [];
  const context = (): NotificationContext => {
    const s = useStore.getState();
    return {
      enabled: s.settings?.desktopNotifications !== false,
      windowHidden: document.hidden || !document.hasFocus(),
      visibleSessionId: s.view === 'chat' ? s.activeSessionId : null,
      titleOf: (id) => s.sessions.find((x) => x.id === id)?.title,
    };
  };
  const post = (notice: Notice) => {
    const key = `${notice.sessionId}:${notice.kind}`;
    const now = Date.now();
    if ((recent.get(key) ?? 0) > now - DEDUPE_MS) return;
    recent.set(key, now);
    try {
      const n = new Notification(notice.title, { body: notice.body, tag: key, silent: notice.kind === 'finished' });
      n.onclick = () => {
        window.focus();
        const s = useStore.getState();
        s.setActiveSession(notice.sessionId);
        s.setView('chat');
        n.close();
      };
      shown = [...shown.filter((x) => x !== n).slice(-7), n];
    } catch {
      /* the platform refused; the pane still shows it */
    }
  };
  const off = window.nekko.onAgentEvent((event: AgentEvent) => {
    const notice = decideNotification(event, context());
    if (!notice) return;
    if (Notification.permission === 'granted') post(notice);
    else if (Notification.permission === 'default') {
      Notification.requestPermission().then((p) => { if (p === 'granted') post(notice); }).catch(() => {});
    }
  });
  return () => {
    off();
    for (const n of shown) n.close();
    shown = [];
  };
}
