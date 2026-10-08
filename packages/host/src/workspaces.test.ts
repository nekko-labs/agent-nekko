import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
