import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = readFileSync(new URL('../../scripts/dev-launch.mjs', import.meta.url), 'utf8');
describe('development launcher safety', () => {
  it('copies a versioned private runtime with relative framework symlinks preserved', () => {
    expect(source).toContain("require('electron/package.json').version");
    expect(source).toContain('verbatimSymlinks: true');
    expect(source).toContain("'Nekko Agent.app'");
  });
  it('uses LaunchServices and a distinct development bundle identity', () => {
    expect(readFileSync(new URL('../../scripts/dev-launch-wrapper.cjs', import.meta.url), 'utf8')).toContain("'/usr/bin/open'");
    expect(source).toContain('com.nekkoagent.desktop.dev');
    expect(source).toContain("env.ELECTRON_EXEC_PATH = prepared.launcher");
  });
  it('rejects node-mode Electron and leaves user privacy grants alone', () => {
    expect(source).toContain('Unset ELECTRON_RUN_AS_NODE');
    expect(source).not.toContain('tccutil');
  });
});
