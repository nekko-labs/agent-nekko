/** Shared subscriptions prevent duplicate card timers for the same chat. */
const polls = new Map<string, { count: number; dispose: () => void }>();
export function subscribePrPolling(sessionId: string, refresh: () => Promise<void>): () => void {
  let poll = polls.get(sessionId);
  if (!poll) {
    let busy = false;
    let disposed = false;
    const run = async () => {
      if (busy || disposed || document.hidden) return;
      busy = true;
      try { await refresh(); } catch { /* Keep the last known state on network failure. */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => void run(), 20_000);
    const focus = () => void run();
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    // Chat load already fetches after paint; polling must not delay its first frame.
    poll = { count: 0, dispose: () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    } };
    polls.set(sessionId, poll);
  }
  poll.count++;
  return () => {
    if (--poll!.count === 0) { poll!.dispose(); polls.delete(sessionId); }
  };
}
