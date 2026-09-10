import type { App } from 'electron';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

/** The profile folder name, and the earlier brands' names, newest first. */
const PROFILE = 'Agent Nekko';
const LEGACY_PROFILES = ['Kotrain', 'Nekkos', 'Open Paw'];

/**
 * Entries never carried across a rename: Chromium rebuilds them, they can be
 * gigabytes, and the lock files are meaningless (or actively harmful) in a
 * copy. Everything else, including `Local Storage` and the host's own data
 * dir, is the user's and moves with them.
 */
const DISPOSABLE = /^(Cache|Code Cache|GPUCache|DawnCache|ShaderCache|GrShaderCache|Crashpad|logs|Singleton|Local State|lockfile|\.lock)/i;

/**
 * Pin the packaged app's profile to a stable folder, and adopt an earlier
 * brand's profile the first time a renamed build runs.
 *
 * Electron derives userData from the product name, so renaming the app would
 * point it at an empty folder and look like every chat and setting was lost.
 * Pinning it by hand is what made the display-name rename safe; the copy below
 * is what makes renaming the *folder* safe, which the appId change means we can
 * finally do.
 */
export function preservePackagedProfile(app: Pick<App, 'isPackaged' | 'getPath' | 'setPath'>): void {
  if (!app.isPackaged) return;
  const appData = app.getPath('appData');
  const profile = join(appData, PROFILE);
  if (!existsSync(profile)) adoptLegacyProfile(appData, profile);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
}

/** Copy the newest earlier-brand profile into `profile`, minus the throwaway parts. */
function adoptLegacyProfile(appData: string, profile: string): void {
  for (const name of LEGACY_PROFILES) {
    const legacy = join(appData, name);
    if (!existsSync(legacy)) continue;
    try {
      mkdirSync(profile, { recursive: true });
      for (const entry of readdirSync(legacy)) {
        if (DISPOSABLE.test(entry)) continue;
        cpSync(join(legacy, entry), join(profile, entry), { recursive: true });
      }
    } catch (err) {
      // A partial copy is still better than an empty profile, and the app has
      // to start either way.
      console.error('[agent-nekko] adopting the', name, 'profile failed:', err);
    }
    return;
  }
}
