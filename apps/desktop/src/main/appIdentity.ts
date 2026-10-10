import type { App } from 'electron';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { defaultUserDataDir } from '@agent-nekko/host/user-data';

/** The profile folder name. */
const PROFILE = 'Agent Nekko';

/**
 * Pin the packaged app's profile to a stable folder.
 *
 * Electron derives userData from the product name, so pinning it by hand keeps
 * the profile location independent of display-name details.
 */
export function preservePackagedProfile(app: Pick<App, 'isPackaged' | 'getPath' | 'setPath'>, root = defaultUserDataDir()): void {
  const profile = join(root, 'desktop');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}
