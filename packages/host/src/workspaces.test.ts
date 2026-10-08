import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { running } = vi.hoisted(() => ({ running: new Set<string>() }));
vi.mock('./chat.js', async (original) => ({ ...await original<typeof import('./chat.js')>(), isChatRunning: (id: string) => running.has(id) }));

const { createHost } = await import('./host.js');

describe('workspace folders', () => {
  it('registers a path once, trailing separator or not', () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-workspaces-')) });
    const root = mkdtempSync(join(tmpdir(), 'nekko-folder-'));

    const first = host.addWorkspaceByPath(root);
    const again = host.addWorkspaceByPath(`${root}/`);

    expect(again).toEqual(first);
    expect(host.listWorkspaces().filter((w) => w.path === root)).toHaveLength(1);
  });
});

describe('workspace access revocation', () => {
  it('detaches saved access without deleting files or promoting another folder', () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-revoke-')) });
    const root = mkdtempSync(join(tmpdir(), 'nekko-folder-'));
    writeFileSync(join(root, 'keep.txt'), 'keep');
    const [a] = host.addWorkspaceByPath(root);
    const b = host.addWorkspaceByPath(mkdtempSync(join(tmpdir(), 'nekko-support-'))).find((w) => w.id !== a.id)!;
    const s = host.createSession(a.id);
    host.setSessionSupportingWorkspaces(s.id, [b.id]);
    host.removeWorkspace(a.id);
    expect(host.listWorkspaces().some((w) => w.id === a.id)).toBe(false);
    expect(host.getSession(s.id)?.workspaceId).toBeUndefined();
    expect(host.getSession(s.id)?.supportingWorkspaceIds).toEqual([b.id]);
    expect(existsSync(root)).toBe(true);
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('keep');
    expect(() => host.setSessionWorkspace(s.id, a.id)).toThrow('Workspace not found');
  });
  it('rejects revocation and folder mutations while an affected chat runs', () => {
    const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'nekko-busy-')) });
    const [a] = host.addWorkspaceByPath(mkdtempSync(join(tmpdir(), 'nekko-folder-')));
    const s = host.createSession();
    host.setSessionSupportingWorkspaces(s.id, [a.id]);
    running.add(s.id);
    try {
      expect(() => host.removeWorkspace(a.id)).toThrow('Wait for chats');
      expect(() => host.setSessionWorkspace(s.id, a.id)).toThrow('Wait for the current reply');
      expect(() => host.setSessionSupportingWorkspaces(s.id, [])).toThrow('Wait for the current reply');
      expect(host.listWorkspaces()).toContainEqual(a);
      expect(host.getSession(s.id)?.supportingWorkspaceIds).toEqual([a.id]);
    } finally { running.delete(s.id); }
    host.removeWorkspace(a.id);
    expect(host.getSession(s.id)?.supportingWorkspaceIds).toEqual([]);
  });
});
