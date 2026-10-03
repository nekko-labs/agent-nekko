import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import type { AppSettings, Session, WorkspaceFolder } from '@agent-nekko/shared';
import { getSessionWorkspaceIds } from '@agent-nekko/shared';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).trim();
}

/** Provision lazily: a new chat may select its project after creation. Old chats never opt in implicitly. */
export function prepareChatWorktrees(session: Session, settings: AppSettings): void {
  if (!session.gitIsolation || settings.gitManagement?.mode === 'shared') return;
  session.gitWorktrees ??= {};
  for (const id of getSessionWorkspaceIds(session)) {
    if (session.gitWorktrees[id]) continue;
    const folder = settings.workspaces.find((w) => w.id === id);
    if (!folder) continue;
    // Distinguish ordinary folders from Git failures; a broken Git checkout must not silently run shared.
    let root: string;
    try { root = git(folder.path, ['rev-parse', '--show-toplevel']); }
    catch (error) {
      const message = String((error as { stderr?: unknown }).stderr ?? error);
      if (/not a git repository/i.test(message)) continue;
      throw new Error(`Could not inspect Git project ${folder.name}: ${message}`);
    }
    const existing = Object.values(session.gitWorktrees).find((w) => resolve(w.sourceRoot) === resolve(root));
    if (existing) {
      session.gitWorktrees[id] = { ...existing, path: join(existing.root, relative(root, folder.path)) };
      continue;
    }
    const dirty = !!git(root, ['status', '--porcelain']);
    const common = resolve(root, git(root, ['rev-parse', '--git-common-dir']));
    const target = join(common, 'nekko-worktrees', session.id);
    const branch = `nekko/${session.id}`;
    mkdirSync(join(common, 'nekko-worktrees'), { recursive: true });
    try {
      git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      if (dirty && settings.gitManagement?.baseline === 'local-changes') {
        const patch = execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        if (patch.length) {
          const patchPath = join(common, 'nekko-worktrees', `${session.id}.patch`);
          try { writeFileSync(patchPath, patch); git(target, ['apply', patchPath]); }
          finally { unlinkSync(patchPath); }
        }
        // Untracked files are not copied: they may include secrets or large build artifacts.
      }
    } catch (error) {
      throw new Error(`Could not prepare isolated checkout for ${folder.name}. No shared-checkout fallback was used: ${String(error)}`);
    }
    session.gitWorktrees[id] = {
      sourceRoot: root, root: target, path: join(target, relative(root, folder.path)), branch,
      notice: dirty
        ? settings.gitManagement?.baseline === 'local-changes'
          ? 'This chat uses an isolated worktree with tracked local edits copied in. Untracked files were not copied.'
          : 'This chat starts in an isolated worktree from committed HEAD. Existing local changes are not included. Interrupt if you want this chat based on those local changes instead; change Git management settings before starting a new chat.'
        : 'This chat uses an isolated Git worktree from committed HEAD.',
    };
  }
}

export function chatWorkspaces(session: Session | null, settings: AppSettings): WorkspaceFolder[] {
  if (!session) return settings.workspaces;
  return getSessionWorkspaceIds(session).flatMap((id) => {
    const folder = settings.workspaces.find((w) => w.id === id);
    return folder ? [{ ...folder, path: session.gitWorktrees?.[id]?.path ?? folder.path }] : [];
  });
}
