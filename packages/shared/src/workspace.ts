/** Workspace folders + codebase index types. */

import type { PrInfo } from './pr.js';

export interface WorkspaceFolder {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

/**
 * The git position of a workspace folder, as the sidebar states it.
 *
 * Deliberately the handful of facts a card can show in one line rather than a
 * full status: which branch the work is on, whether it has uncommitted changes,
 * and how far it has drifted from its upstream. A folder that is not a
 * repository is a real answer (`repo: false`), not an error, because plenty of
 * workspaces are just folders.
 */
export interface GitStatus {
  workspaceId: string;
  /** False when the folder is not inside a git repository at all. */
  repo: boolean;
  /** Current branch, or undefined on a detached HEAD. */
  branch?: string;
  /** Short commit sha, which is all a detached HEAD has to identify itself. */
  head?: string;
  /** Number of files with uncommitted modifications (staged or not). */
  dirtyCount: number;
  /** Commits ahead of the tracking branch, when there is one. */
  ahead: number;
  /** Commits behind the tracking branch, when there is one. */
  behind: number;
  /**
   * Set when the folder is a *linked* worktree (`git worktree add`) rather than
   * the repository's main checkout, which is how two agents work one repo
   * without trampling each other. `name` is the worktree folder's name.
   */
  worktree?: { name: string; path: string };
  /**
   * The pull request for this branch, when `gh` can see one. This is the PR
   * the work is going into, which is a different thing from the PRs a chat
   * happens to have mentioned.
   */
  pr?: PrInfo;
  /** Epoch ms this was read, so the UI can age it out. */
  updatedAt: number;
}

export interface IndexedFile {
  path: string;
  /** Relative to its workspace root. */
  relPath: string;
  sizeBytes: number;
  language?: string;
  /** Code symbols discovered by the lightweight outline parser. */
  symbols: CodeSymbol[];
}

export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'export';
  line: number;
}

export interface IndexStatus {
  workspaceId: string;
  fileCount: number;
  symbolCount: number;
  /** 0..1 */
  progress: number;
  state: 'idle' | 'indexing' | 'ready' | 'error';
  updatedAt: number;
}

export interface SearchHit {
  path: string;
  relPath: string;
  line: number;
  text: string;
}
