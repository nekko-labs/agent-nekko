/** App version + auto-update contracts (desktop electron-updater / web refresh). */

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'none'
  | 'error';

export interface AppInfo {
  version: string;
  platform: string;
  edition: 'desktop' | 'web';
}

export interface UpdateInfo {
  state: UpdateState;
  /** Version currently running. */
  currentVersion: string;
  /** Newer version available/downloaded, when known. */
  version?: string;
  /** Download progress 0–100 (desktop only). */
  percent?: number;
  /** Where the release notes live. */
  notesUrl: string;
  message?: string;
  edition: 'desktop' | 'web';
}

export const RELEASE_NOTES_URL = 'https://github.com/nekko-labs/agent-nekko/releases/latest';
