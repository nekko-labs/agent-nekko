/**
 * Archived chats: out of the workspace list, still on disk, gone for good
 * after a retention window.
 *
 * Closing a card used to be the only way to tidy the sidebar, and it read like
 * a delete while being nothing of the kind, so chats seemed to vanish. Archive
 * is the honest version: the chat leaves the list, it can be read (not
 * continued) from the Archived list, and it is restored or deleted on purpose.
 * Anything nobody restores is deleted once the window runs out, so the
 * archive never grows into a second, slower sidebar.
 */

/** How long an archived chat is kept before it is deleted. */
export const ARCHIVE_RETENTION_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a chat (or its summary) is archived. */
export function isArchived(s: { archivedAt?: number | null }): boolean {
  return typeof s.archivedAt === 'number' && s.archivedAt > 0;
}

/** When an archived chat is due to be deleted (epoch ms). */
export function archiveDeletesAt(archivedAt: number): number {
  return archivedAt + ARCHIVE_RETENTION_DAYS * DAY_MS;
}

/**
 * Whole days left before an archived chat is deleted, rounded up so a chat
 * with hours left still says "1 day" rather than "0", and never negative.
 */
export function archiveDaysLeft(archivedAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((archiveDeletesAt(archivedAt) - now) / DAY_MS));
}

/** Whether an archived chat has outlived the retention window. */
export function archiveExpired(s: { archivedAt?: number | null }, now = Date.now()): boolean {
  return isArchived(s) && now >= archiveDeletesAt(s.archivedAt as number);
}
