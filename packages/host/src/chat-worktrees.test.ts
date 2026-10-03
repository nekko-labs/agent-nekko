import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AppSettings, Session } from '@agent-nekko/shared';
import { chatWorkspaces, listChatWorktrees, prepareChatWorktrees, removeChatWorktree, runWorktreeSetup } from './chat-worktrees.js';

let root: string;
let settings: AppSettings;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
const session = (id: string): Session => ({ id, title: 'New chat', workspaceId: 'repo', gitIsolation: true, messages: [], createdAt: 1, updatedAt: 1 });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nekko-worktree-'));
  git('init');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(root, 'file.txt'), 'committed\n');
  git('add', '.');
  git('commit', '-m', 'Initial');
  settings = { workspaces: [{ id: 'repo', name: 'Repo', path: root }] } as AppSettings;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('isolates concurrent chats from HEAD and preserves local edits', () => {
  writeFileSync(join(root, 'file.txt'), 'local edits\n');
  const a = session('s_a'), b = session('s_b');
  prepareChatWorktrees(a, settings);
  prepareChatWorktrees(b, settings);
  expect(a.gitWorktrees!.repo.path).not.toBe(b.gitWorktrees!.repo.path);
  expect(readFileSync(join(a.gitWorktrees!.repo.path, 'file.txt'), 'utf8')).toBe('committed\n');
  expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('local edits\n');
  expect(a.gitWorktrees!.repo.notice).toContain('Interrupt');
  expect(chatWorkspaces(a, settings)[0].path).toBe(a.gitWorktrees!.repo.path);
  prepareChatWorktrees(a, settings); // idempotent
});
it('copies tracked edits only when configured', () => {
  writeFileSync(join(root, 'file.txt'), 'local edits\n');
  writeFileSync(join(root, 'secret.txt'), 'not copied');
  settings.gitManagement = { baseline: 'local-changes' };
  const a = session('s_copy');
  prepareChatWorktrees(a, settings);
  expect(readFileSync(join(a.gitWorktrees!.repo.path, 'file.txt'), 'utf8')).toBe('local edits\n');
  expect(existsSync(join(a.gitWorktrees!.repo.path, 'secret.txt'))).toBe(false);
});
it('does not move existing chats or shared checkouts', () => {
  const old = session('s_old'); delete old.gitIsolation;
  prepareChatWorktrees(old, settings);
  expect(old.gitWorktrees).toBeUndefined();
  settings.gitManagement = { mode: 'shared' };
  const shared = session('s_shared'); prepareChatWorktrees(shared, settings);
  expect(shared.gitWorktrees).toBeUndefined();
});
it('copies only gitignored files listed in .worktreeinclude', () => {
  writeFileSync(join(root, '.gitignore'), '.env\nbuild/\n');
  writeFileSync(join(root, '.worktreeinclude'), '.env\nnotes.txt\n');
  git('add', '.gitignore', '.worktreeinclude');
  git('commit', '-m', 'Ignore');
  writeFileSync(join(root, '.env'), 'TOKEN=local\n');
  writeFileSync(join(root, 'notes.txt'), 'untracked but not ignored');
  mkdirSync(join(root, 'build'));
  writeFileSync(join(root, 'build', 'out.js'), 'not listed');
  const a = session('s_incl');
  prepareChatWorktrees(a, settings);
  const wt = a.gitWorktrees!.repo.path;
  expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('TOKEN=local\n');
  expect(existsSync(join(wt, 'notes.txt'))).toBe(false);
  expect(existsSync(join(wt, 'build'))).toBe(false);
  expect(a.gitWorktrees!.repo.notice).toContain('.worktreeinclude: .env');
});
it('lists, removes, and restores chat worktrees without losing work', () => {
  const a = session('s_life');
  expect(prepareChatWorktrees(a, settings)).toHaveLength(1);
  const wt = a.gitWorktrees!.repo.root;
  const owner = (id: string) => (id === 's_life' ? { title: 'Life', running: false } : null);
  let [info] = listChatWorktrees(settings, owner);
  expect(info).toMatchObject({ sessionId: 's_life', sessionTitle: 'Life', branch: 'nekko/s_life', dirtyCount: 0, unmergedCount: 0 });

  // Uncommitted work and a running chat both block removal.
  writeFileSync(join(wt, 'file.txt'), 'work in progress\n');
  expect(() => removeChatWorktree(settings, wt, owner)).toThrow(/uncommitted/);
  execFileSync('git', ['commit', '-am', 'Chat work'], { cwd: wt });
  expect(() => removeChatWorktree(settings, wt, () => ({ title: 'Life', running: true }))).toThrow(/running/);
  [info] = listChatWorktrees(settings, owner);
  expect(info.unmergedCount).toBe(1);

  // An unmerged branch survives removal, and the chat comes back on it.
  expect(removeChatWorktree(settings, wt, owner)).toEqual({ branchDeleted: false });
  expect(existsSync(wt)).toBe(false);
  expect(listChatWorktrees(settings, owner)).toHaveLength(0);
  mkdirSync(wt); // Windows can leave the emptied folder behind while a terminal has it open
  expect(prepareChatWorktrees(a, settings)).toHaveLength(1);
  expect(readFileSync(join(wt, 'file.txt'), 'utf8')).toBe('work in progress\n');
  expect(a.gitWorktrees!.repo.notice).toContain('restored from its branch');

  // Once merged, the branch goes with the folder.
  git('merge', '--ff-only', 'nekko/s_life');
  expect(removeChatWorktree(settings, wt, owner)).toEqual({ branchDeleted: true });
  expect(() => removeChatWorktree(settings, root, owner)).toThrow(/not a chat worktree/);
});
it('runs setup commands and reports failures without throwing', async () => {
  let out = '';
  const ok = await runWorktreeSetup('echo setup-ran', root, (t) => { out += t; });
  expect(ok.ok).toBe(true);
  expect(out).toContain('setup-ran');
  const bad = await runWorktreeSetup('exit 3', root, () => {});
  expect(bad).toEqual({ ok: false, detail: 'exit code 3' });
});
