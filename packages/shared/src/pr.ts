/** Pull-request types + helpers for the in-chat PR card, diff pane, and badges.
 *
 * Agent Nekko doesn't track PRs itself; a chat "has" a PR when a GitHub PR URL shows
 * up in its transcript (the agent runs `gh pr create`, the URL lands in tool
 * output, or the user pastes one). We extract those URLs and hydrate live state
 * via the `gh` CLI, falling back to the GitHub REST API with the connector PAT.
 */

export type PrState = 'open' | 'merged' | 'closed';

/** Rolled-up CI status across a PR's head-commit checks. */
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none';

export interface PrInfo {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName?: string;
  baseRefName?: string;
  /** 'approved' | 'changes_requested' | 'review_required' | null (gh only). */
  reviewDecision?: string | null;
  checks: PrChecks;
  mergedAt?: string | null;
  updatedAt?: string | null;
  /** Where the live state came from, for graceful-degradation messaging. */
  source: 'gh' | 'api';
}

export type PrFileStatus = 'added' | 'removed' | 'modified' | 'renamed';

export interface PrDiffFile {
  path: string;
  /** Prior path for renames. */
  oldPath?: string;
  status: PrFileStatus;
  additions: number;
  deletions: number;
  /** Unified-diff hunks (from the first `@@`), parsed client-side for rendering. */
  patch: string;
}

export interface PrDiff {
  url: string;
  files: PrDiffFile[];
  /** True when the diff was capped (very large PR). */
  truncated?: boolean;
}

export type PrAction = 'approve' | 'close' | 'merge' | 'reopen';

export interface PrActionResult {
  ok: boolean;
  message: string;
  /** Refreshed PR state after the action, when it could be re-read. */
  pr?: PrInfo;
}

const PR_URL_RE = /https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g;

/** Every unique GitHub PR URL mentioned in a blob of text, trailing punctuation trimmed. */
export function extractPrUrls(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(PR_URL_RE)) out.add(m[0].replace(/[).,\]]+$/, ''));
  return [...out];
}

/** Parse owner / repo / number out of a GitHub PR URL. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Collect the PR URLs referenced anywhere in a chat's messages (content + tool output). */
export function collectSessionPrUrls(
  messages: Array<{ content?: string; toolResult?: { output?: string } }>,
): string[] {
  const urls = new Set<string>();
  for (const m of messages) {
    for (const u of extractPrUrls(m.content ?? '')) urls.add(u);
    if (m.toolResult?.output) for (const u of extractPrUrls(m.toolResult.output)) urls.add(u);
  }
  return [...urls];
}
