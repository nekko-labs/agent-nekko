import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliBinPath, cliInstallStatus, dirOnPath, installCli, launcherScript, writeCliLink } from './cli-install.js';

/**
 * The installer runs against a throwaway userData and never touches PATH
 * (`path: false`), so these tests cannot change the machine they run on.
 */
function fakeApp(withCli: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'nekko-cli-'));
  const appPath = join(root, 'apps', 'desktop');
  mkdirSync(appPath, { recursive: true });
  if (withCli) {
    mkdirSync(join(root, 'apps', 'cli', 'app-dist'), { recursive: true });
    writeFileSync(join(root, 'apps', 'cli', 'app-dist', 'nekko-agent-cli.cjs'), '// cli');
  }
  const userData = join(root, 'userData');
  return {
    root,
    userData,
    app: { isPackaged: false, getAppPath: () => appPath, getPath: () => userData },
  };
}

describe('cli install', () => {
  it('launches the bundled CLI through Electron as Node, passing arguments on', () => {
    const script = launcherScript('/Apps/Nekko Agent', '/res/cli/nekko-agent-cli.cjs');
    expect(script).toContain('ELECTRON_RUN_AS_NODE=1');
    expect(script).toContain('"/Apps/Nekko Agent" "/res/cli/nekko-agent-cli.cjs"');
    expect(script).toMatch(process.platform === 'win32' ? /%\*/ : /"\$@"/);
  });

  it('matches a PATH entry regardless of case and trailing slash', () => {
    const path = ['/usr/bin', '/Users/me/Nekko/bin/'].join(delimiter);
    expect(dirOnPath('/users/me/nekko/bin', path)).toBe(true);
    expect(dirOnPath('/opt/other', path)).toBe(false);
  });

  it('writes the launcher when the build carries the CLI', () => {
    const { app, userData } = fakeApp(true);
    const status = installCli(app, { path: false });
    expect(status.installed).toBe(true);
    expect(existsSync(cliBinPath(userData))).toBe(true);
    expect(readFileSync(cliBinPath(userData), 'utf8')).toContain('nekko-agent-cli.cjs');
    expect(cliInstallStatus(app).installed).toBe(true);
  });

  it('says so, with the npm fallback, when the build has no CLI', () => {
    const { app } = fakeApp(false);
    const status = installCli(app, { path: false });
    expect(status.installed).toBe(false);
    expect(status.message).toMatch(/npm install -g nekko-agent/);
  });

  it('writes the link file the CLI reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nekko-linkfile-'));
    writeCliLink(dir, { url: 'http://127.0.0.1:1439', token: 'k', enabled: true, updatedAt: 1 });
    expect(JSON.parse(readFileSync(join(dir, 'cli-link.json'), 'utf8'))).toMatchObject({ token: 'k', enabled: true });
  });
});
