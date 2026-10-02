import { describe, expect, it } from 'vitest';
import { ARCHIVE_RETENTION_DAYS, archiveDaysLeft, archiveExpired, isArchived } from './archive.js';

const DAY = 24 * 60 * 60 * 1000;

describe('archive retention', () => {
  it('treats absent, null and zero as live', () => {
    expect(isArchived({})).toBe(false);
    expect(isArchived({ archivedAt: null })).toBe(false);
    expect(isArchived({ archivedAt: 0 })).toBe(false);
    expect(isArchived({ archivedAt: 1 })).toBe(true);
  });

  it('counts whole days left, rounding a partial day up', () => {
    const at = 1_000_000_000_000;
    expect(archiveDaysLeft(at, at)).toBe(ARCHIVE_RETENTION_DAYS);
    expect(archiveDaysLeft(at, at + DAY)).toBe(ARCHIVE_RETENTION_DAYS - 1);
    expect(archiveDaysLeft(at, at + (ARCHIVE_RETENTION_DAYS - 1) * DAY + 1)).toBe(1);
    expect(archiveDaysLeft(at, at + ARCHIVE_RETENTION_DAYS * DAY + 5)).toBe(0);
  });

  it('expires only archived chats past the window', () => {
    const at = 1_000_000_000_000;
    expect(archiveExpired({ archivedAt: at }, at + (ARCHIVE_RETENTION_DAYS * DAY) - 1)).toBe(false);
    expect(archiveExpired({ archivedAt: at }, at + ARCHIVE_RETENTION_DAYS * DAY)).toBe(true);
    expect(archiveExpired({}, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});
