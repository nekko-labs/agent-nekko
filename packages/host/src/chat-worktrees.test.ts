import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AppSettings, Session } from '@agent-nekko/shared';
import { chatWorkspaces, prepareChatWorktrees } from './chat-worktrees.js';

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
