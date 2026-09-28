import { describe, expect, it } from 'vitest';
import { parsePorcelainV2, parseWorktree } from './git.js';

/**
 * The porcelain v2 format is parsed rather than the human-readable one because
 * it is specified and stable. These cover the shapes a workspace card actually
 * meets: a clean branch, a dirty one, a detached HEAD, and a fresh repo with no
 * commits or upstream yet.
 */
describe('parsePorcelainV2', () => {
  it('reads branch and upstream drift from a clean tree', () => {
    const out = [
      '# branch.oid 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      '# branch.head feat/model-server-tab',
      '# branch.upstream origin/feat/model-server-tab',
      '# branch.ab +2 -3',
    ].join('\n');

    expect(parsePorcelainV2('ws1', out)).toMatchObject({
      workspaceId: 'ws1',
      repo: true,
      branch: 'feat/model-server-tab',
      head: '1a2b3c4',
      dirtyCount: 0,
      ahead: 2,
      behind: 3,
    });
  });

  it('counts changed, untracked and unmerged paths as dirt', () => {
    const out = [
      '# branch.oid 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b',
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 abc abc packages/host/src/limits.ts',
      '1 M. N... 100644 100644 100644 def def packages/host/src/git.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflicted.ts',
      '? apps/desktop/src/renderer/untracked.tsx',
    ].join('\n');

    expect(parsePorcelainV2('ws1', out).dirtyCount).toBe(4);
  });

  it('does not count ignored paths as dirt', () => {
    const out = [
      '# branch.head main',
      '1 .M N... 100644 100644 100644 abc abc real-change.ts',
      '! node_modules/',
    ].join('\n');

    expect(parsePorcelainV2('ws1', out).dirtyCount).toBe(1);
  });

  it('reports a detached HEAD as a sha rather than a branch', () => {
    const out = [
      '# branch.oid 9f8e7d6c5b4a39281706f5e4d3c2b1a098765432',
      '# branch.head (detached)',
    ].join('\n');

    const status = parsePorcelainV2('ws1', out);
    expect(status.branch).toBeUndefined();
    expect(status.head).toBe('9f8e7d6');
  });

  it('handles a repo with no commits and no upstream', () => {
    const out = ['# branch.oid (initial)', '# branch.head main'].join('\n');

    const status = parsePorcelainV2('ws1', out);
    expect(status).toMatchObject({ repo: true, branch: 'main', ahead: 0, behind: 0, dirtyCount: 0 });
    // "(initial)" is not a sha, so there is nothing to show for HEAD yet.
    expect(status.head).toBeUndefined();
  });

  it('keeps a branch name that contains spaces or slashes intact', () => {
    const out = '# branch.head feature/some-long/name-here';
    expect(parsePorcelainV2('ws1', out).branch).toBe('feature/some-long/name-here');
  });
});

describe('parseWorktree', () => {
  it('says nothing for the main checkout', () => {
    expect(parseWorktree('.git\n.git\nC:/code/agent-nekko\n', 'C:/code/agent-nekko')).toBeUndefined();
  });

  it('names a linked worktree by its folder', () => {
    const out = 'C:/code/agent-nekko/.git/worktrees/fix-chat\nC:/code/agent-nekko/.git\nC:/code/.worktrees/fix-chat\n';
    expect(parseWorktree(out, 'C:/code/.worktrees/fix-chat')).toEqual({
      name: 'fix-chat',
      path: 'C:/code/.worktrees/fix-chat',
    });
  });
});
