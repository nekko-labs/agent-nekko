import { getExecutionMode } from '@nekko-agent/shared';
import { getSession } from './sessions.js';

/** Unscoped user APIs remain host APIs, not sandbox capabilities. */
export function assertHostExecution(sessionId: string | undefined, action: string): void {
  const session = sessionId ? getSession(sessionId) : undefined;
  if (sessionId && !session) throw new Error(`${action}: session not found. No host fallback.`);
  if (session && getExecutionMode(session) === 'sandbox') {
    throw new Error(`${action} is unsupported in sandbox sessions. Use scoped container file and bash tools. No host fallback.`);
  }
}
