import { useEffect, useState } from 'react';
import type { GitStatus } from '@agent-nekko/shared';

/** How often a visible card re-reads git. The host caches under this anyway. */
const POLL_MS = 15_000;

/**
 * The git position of a workspace folder, for the sidebar cards.
 *
 * Polled rather than pushed: branch changes and commits happen in the user's
 * own terminal as often as they happen through the agent, so there is no event
 * to subscribe to. The host caches and coalesces per folder, so several cards
 * over one repo cost a single `git` however many of them are on screen.
 *
 * Returns null while the first read is in flight and for a folder that is not a
 * repository, so a caller can render nothing without special-casing either.
 */
export function useGitStatus(workspaceId: string | undefined): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setStatus(null);
      return;
    }
    let live = true;
    const read = () => {
      window.nekko
        .getGitStatus(workspaceId)
        .then((s) => { if (live) setStatus(s.repo ? s : null); })
        .catch(() => { if (live) setStatus(null); });
    };
    read();
    const t = setInterval(read, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, [workspaceId]);

  return status;
}
