import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('./store.js', () => ({ dataDir: () => state.root, getSettings: () => ({ workspaces: [{ id: 'project', path: state.root }] }) }));
vi.mock('./oauth.js', () => ({ resolveSubscriptionProvider: vi.fn() }));
import { addDesignPage, getDesignBoard, updateDesignPage } from './design.js';
afterEach(() => { if (state.root) rmSync(state.root, { recursive: true, force: true }); });
describe('portable design import and restore', () => {
  it('copies explicitly imported HTML and persists restore in board and editable file', () => {
    state.root = mkdtempSync(join(tmpdir(), 'nekko-design-import-'));
    const original = join(state.root, 'original.html');
    writeFileSync(original, '<h1>Original</h1>');
    const imported = addDesignPage('project', 'Example', original).pages[0];
    expect(imported.file).not.toBe(original);
    expect(readFileSync(imported.file!, 'utf8')).toBe(imported.html);
    const changed = updateDesignPage('project', imported.id, { html: '<h1>Changed</h1>' }).pages[0];
    const restored = updateDesignPage('project', imported.id, { html: changed.revisions![0].html }).pages[0];
    expect(restored.html).toBe('<h1>Original</h1>');
    expect(restored.revisions?.at(-1)?.html).toBe('<h1>Changed</h1>');
    expect(getDesignBoard('project').pages[0]).toEqual(restored);
    expect(readFileSync(imported.file!, 'utf8')).toBe(restored.html);
    expect(readFileSync(original, 'utf8')).toBe('<h1>Original</h1>');
  });
  it('rejects missing files without creating an empty concept', () => {
    state.root = mkdtempSync(join(tmpdir(), 'nekko-design-import-'));
    expect(() => addDesignPage('project', 'Missing', join(state.root, 'missing.html'))).toThrow('does not exist');
    expect(getDesignBoard('project').pages).toEqual([]);
  });
});
