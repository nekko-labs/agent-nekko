import { randomUUID } from 'node:crypto';
import type { DesignPage } from '@agent-nekko/shared';

/** Restore is a new revision, never destructive history rewriting. */
export function reviseDesign(page: DesignPage, patch: Partial<Pick<DesignPage, 'label' | 'url' | 'html'>>): DesignPage {
  if (patch.html !== undefined && (typeof patch.html !== 'string' || Buffer.byteLength(patch.html) > 1_000_000)) throw new Error('Design HTML must be under 1 MB.');
  const revisions = [...(page.revisions ?? [])];
  if (patch.html !== undefined && patch.html !== page.html && page.html !== undefined) {
    revisions.push({ id: randomUUID(), html: page.html, createdAt: page.updatedAt });
  }
  return { ...page, ...patch, revisions: revisions.slice(-10), updatedAt: Date.now() };
}
