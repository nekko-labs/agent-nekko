/**
 * Where a workspace folder is in git, for the sidebar's workspace cards.
 *
 * The cards say what an agent is working on, and "which branch" is the single
 * most load-bearing fact there: two workspaces over the same repo are a
 * different thing entirely depending on whether one of them is on a feature
 * branch. Nothing else in the app reads git, so this is the whole of it.
 *
 * Three deliberate limits, because this runs for every visible card on a timer:
 *
 * - **One command.** `git status --porcelain=v2 --branch` reports the branch,
 *   the upstream divergence and the dirty files in a single machine-readable
 *   pass, so a card costs one process rather than three.
 * - **Cached and coalesced.** A result is reused for a few seconds and
 *   concurrent callers share one in-flight read, so eight cards over the same
 *   repo do not spawn eight gits.
 * - **Never throws.** A missing git, a folder that is not a repository, a
 *   permission error, and a timeout all resolve to a plain answer. A sidebar
 *   card must not be able to take a window down.
 */

import { execFile } from 'child_process';
import type { GitStatus } from '@agent-nekko/shared';
import { trimTrailingSlashes } from '@agent-nekko/shared';
import { getSettings } from './store.js';
import { branchPr } from './pr.js';
import { getSession } from './sessions.js';
import { chatWorkspaces } from './chat-worktrees.js';

/** How long a read stays fresh. Long enough to absorb a render storm. */
const CACHE_MS = 5_000;
/** A repository that is slow to stat is not worth blocking a card for. */
const TIMEOUT_MS = 5_000;

const cache = new Map<string, GitStatus>();
const inFlight = new Map<string, Promise<GitStatus>>();

/** True once we learn git is not on PATH, so we stop paying to rediscover it. */
let gitMissing = false;

/** Run git in a folder, resolving its output. Never rejects. */
function run(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const missing = !!e && (e.code === 'ENOENT' || e.errno === -4058);
        resolve({ ok: !err, stdout: stdout ?? '', missing });
      },
    );
  });
}

/** The answer for a folder that has no git position to report. */
function notARepo(workspaceId: string): GitStatus {
  return { workspaceId, repo: false, dirtyCount: 0, ahead: 0, behind: 0, updatedAt: Date.now() };
}

/**
 * Parse `git status --porcelain=v2 --branch`.
 *
 * The v2 format is used precisely because it is specified: headers are `# key
 * value` lines, and every other line is one changed path. That means the dirty
 * count is a line count rather than a guess about which status codes imply a
 * modification, and it is unaffected by the user's git config, aliases, or
 * locale, all of which can reshape the human-readable format.
 */
export function parsePorcelainV2(workspaceId: string, stdout: string): GitStatus {
  const status: GitStatus = {
    workspaceId,
    repo: true,
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    updatedAt: Date.now(),
  };

  for (const line of stdout.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      // A detached HEAD reports the literal "(detached)" rather than a name.
      if (head && head !== '(detached)') status.branch = head;
      continue;
    }
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim();
      if (oid && oid !== '(initial)') status.head = oid.slice(0, 7);
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      // "+2 -3": ahead of upstream by 2, behind by 3.
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        status.ahead = parseInt(m[1], 10);
        status.behind = parseInt(m[2], 10);
      }
      continue;
    }
    // Any other header is not one we report on.
    if (line.startsWith('# ')) continue;
    // Everything else is a path entry: changed (1/2), unmerged (u), untracked
    // (?), or ignored (!). Ignored files never appear without --ignored, and an
    // untracked file is a change the user can see in their editor, so both of
    // the first two count as dirt.
    if (line.startsWith('! ')) continue;
    status.dirtyCount += 1;
  }

  return status;
}

/**
 * Is this checkout a linked worktree, and if so what is it called?
 *
 * `--git-dir` and `--git-common-dir` are the same path in a main checkout and
 * differ in a linked worktree (its git dir lives under the main repo's
 * `.git/worktrees/<name>`). Takes the output of
 * `git rev-parse --git-dir --git-common-dir --show-toplevel`, run in `cwd`.
 */
export function parseWorktree(stdout: string, cwd: string): { name: string; path: string } | undefined {
  const [gitDir, commonDir, top] = stdout.split(/\r?\n/).map((l) => l.trim());
  if (!gitDir || !commonDir || !top) return undefined;
  // git prints these relative to cwd in a main checkout (".git") and absolute
  // in a worktree, so compare them resolved, slash-normalized, and caseless.
  const norm = (p: string) => {
    const abs = /^([a-zA-Z]:)?[\\/]/.test(p) ? p : `${trimTrailingSlashes(cwd, true)}/${p}`;
    return trimTrailingSlashes(abs.replace(/\\/g, '/')).toLowerCase();
  };
  if (norm(gitDir) === norm(commonDir)) return undefined;
  const path = top.replace(/\\/g, '/');
  return { name: path.split('/').filter(Boolean).pop() ?? path, path };
}

/** How long a branch's PR lookup may hold a card's first read. */
const PR_WAIT_MS = 3_000;

/**
 * Read a workspace folder's git position.
 *
 * Cached for a few seconds and coalesced across concurrent callers, so a
 * sidebar full of cards over one repo costs a single `git`.
 */
export async function getGitStatus(workspaceId: string, force = false): Promise<GitStatus> {
  // A session handle resolves its primary checkout without accepting arbitrary filesystem paths.
  const session = workspaceId.startsWith('session:') ? getSession(workspaceId.slice(8)) : null;
  const folder = workspaceId.startsWith('session:')
    ? session ? chatWorkspaces(session, getSettings())[0] : undefined
    : getSettings().workspaces.find((w) => w.id === workspaceId);
  if (!folder?.path) return notARepo(workspaceId);
  // Isolation is provisioned on first send. Until then the source checkout is
  // a baseline, not this chat's branch/worktree/PR.
  if (session?.gitIsolation && !Object.keys(session.gitWorktrees ?? {}).length) return notARepo(workspaceId);
  // A session handle can change checkout after provisioning or a mode switch.
  // Never reuse the source checkout's cached status for the new path.
  const cacheKey = `${workspaceId}|${folder.path}`;

  const cached = cache.get(cacheKey);
  if (!force && cached && cached.updatedAt + CACHE_MS > Date.now()) return cached;

  const existing = inFlight.get(cacheKey);
  if (existing) return existing;

  const promise = (async (): Promise<GitStatus> => {
    if (gitMissing) return notARepo(workspaceId);
    const res = await run(folder.path, ['status', '--porcelain=v2', '--branch']);
    if (res.missing) {
      gitMissing = true;
      return notARepo(workspaceId);
    }
    // A non-zero exit here is almost always "not a git repository", which is a
    // perfectly ordinary thing for a workspace folder to be.
    const status = res.ok ? parsePorcelainV2(workspaceId, res.stdout) : notARepo(workspaceId);
    if (status.repo) {
      const wt = await run(folder.path, ['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel']);
      if (wt.ok) status.worktree = parseWorktree(wt.stdout, folder.path);
      // The branch's PR comes from gh, which is slower and cached on its own
      // clock. A lookup that takes longer than a moment finishes in the
      // background and shows up on the next poll rather than holding the card.
      if (status.branch) {
        const pr = await Promise.race([
          branchPr(folder.path, status.branch),
          new Promise<null>((r) => setTimeout(() => r(null), PR_WAIT_MS)),
        ]);
        if (pr) status.pr = pr;
      }
    }
    cache.set(cacheKey, status);
    return status;
  })().finally(() => {
    if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey);
  });

  inFlight.set(cacheKey, promise);
  return promise;
}

/** Drop cached git state, for tests and for an explicit refresh. */
export function clearGitCache(): void {
  cache.clear();
  inFlight.clear();
  gitMissing = false;
}
