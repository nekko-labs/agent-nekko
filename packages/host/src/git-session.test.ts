import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@agent-nekko/shared';

const state = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock('./sessions.js', () => ({ getSession: () => state.session }));
vi.mock('./store.js', () => ({ getSettings: () => ({ workspaces: [{ id: 'repo', path: '/source' }] }) }));
vi.mock('./chat-worktrees.js', () => ({ chatWorkspaces: () => [{ path: state.session?.gitIsolation === false ? '/source' : state.session?.gitWorktrees?.repo.path ?? '/source' }] }));
vi.mock('./pr.js', () => ({ branchPr: vi.fn(async () => ({ state: 'merged', number: 1 })) }));
vi.mock('child_process', () => ({ execFile: vi.fn((_cmd, args, opts, callback) => {
  callback(null, args[0] === 'status' ? `# branch.head ${opts.cwd === '/source' ? 'old-merged-branch' : 'new-chat'}\n` : '.git\n.git\n/source\n');
}) }));
import { clearGitCache, getGitStatus } from './git.js';
import { branchPr } from './pr.js';

describe('session checkout status', () => {
  beforeEach(() => { clearGitCache(); vi.clearAllMocks(); });
  it('does not attribute the source checkout or its merged PR to an unprovisioned isolated chat', async () => {
    state.session = { id: 'new', gitIsolation: true } as Session;
    expect(await getGitStatus('session:new')).toMatchObject({ repo: false });
    expect(branchPr).not.toHaveBeenCalled();
  });
  it('refreshes the checkout immediately when the same chat changes paths', async () => {
    state.session = { id: 'new', gitIsolation: false } as Session;
    expect((await getGitStatus('session:new')).branch).toBe('old-merged-branch');
    state.session.gitIsolation = true;
    state.session.gitWorktrees = { repo: { sourceRoot: '/source', root: '/isolated', path: '/isolated', branch: 'new-chat', notice: '' } };
    expect((await getGitStatus('session:new')).branch).toBe('new-chat');
  });
});
