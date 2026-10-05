import { describe, expect, it } from 'vitest';
import type { DesignPage } from '@agent-nekko/shared';
import { reviseDesign } from './design-revisions.js';
const page: DesignPage = { id: 'a', label: 'Design', url: '', kind: 'concept', html: '<p>one</p>', notes: [], createdAt: 1, updatedAt: 1 };
describe('design history', () => {
  it('preserves the previous document and restores as a new revision', () => {
    const next = reviseDesign(page, { html: '<p>two</p>' });
    expect(next.revisions?.[0].html).toBe(page.html);
    const restored = reviseDesign(next, { html: next.revisions![0].html });
    expect(restored.html).toBe(page.html);
    expect(restored.revisions?.at(-1)?.html).toBe(next.html);
  });
  it('bounds history and avoids snapshots for unchanged HTML', () => {
    let next = page;
    for (let i = 0; i < 20; i++) next = reviseDesign(next, { html: String(i) });
    expect(next.revisions).toHaveLength(10);
    expect(reviseDesign(next, { html: next.html }).revisions).toHaveLength(10);
  });
  it('limits UTF-8 bytes', () => {
    expect(() => reviseDesign(page, { html: '€'.repeat(400_000) })).toThrow('1 MB');
  });
});
