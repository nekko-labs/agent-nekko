import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// Keep the downloaded runtime untouched: other worktrees may be using it.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const electron = require('electron');
if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('Unset ELECTRON_RUN_AS_NODE before launching Agent Nekko');
const env = { ...process.env, NEKKO_DEV_OWNER: randomUUID() };
let ownedCache;
export function prepareMacBundle() {

  const cache = resolve('.dev-runtime', require('electron/package.json').version);
  const bundle = join(cache, 'Agent Nekko.app');
  const ready = join(cache, 'ready');
  if (!existsSync(ready)) {
    mkdirSync(cache, { recursive: true });
    cpSync(resolve(dirname(electron), '../..'), bundle, { recursive: true, verbatimSymlinks: true });
    const plist = join(bundle, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({ CFBundleName: 'Agent Nekko', CFBundleDisplayName: 'Agent Nekko', CFBundleIdentifier: 'com.agentnekko.desktop.dev' })) {
      const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
      if (result.status !== 0 && spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]).status !== 0) throw new Error('Could not set development bundle identity: ' + key);
    }
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    if (signed.status !== 0) throw new Error('Could not sign development bundle');
    writeFileSync(ready, 'signed');
  }
  // LaunchServices makes the app, not the terminal, the responsible process.
  const launcher = join(cache, 'launch.cjs');
  const wrapper = resolve('scripts/dev-launch-wrapper.cjs');
  writeFileSync(launcher, `#!/usr/bin/env node\nrequire(${JSON.stringify(wrapper)}).launch(${JSON.stringify(bundle)},${JSON.stringify(cache)});\n`, { mode: 0o755 });
  return { launcher, bundle, cache };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (process.platform === 'darwin') { const prepared = prepareMacBundle(); env.ELECTRON_EXEC_PATH = prepared.launcher; ownedCache = prepared.cache; }
const cli = resolve(dirname(require.resolve('electron-vite')), '../bin/electron-vite.js');
const child = spawn(process.execPath, [cli, process.argv[2] || 'dev'], { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));

const stop = () => {
  if (ownedCache) for (const name of readdirSync(ownedCache).filter(n => /^launch-.*\.json$/.test(n))) {
    try { const receipt = JSON.parse(readFileSync(join(ownedCache, name), 'utf8')); if (receipt.owner === env.NEKKO_DEV_OWNER && Number.isInteger(receipt.pid) && receipt.pid > 0) process.kill(receipt.pid, 'SIGTERM'); } catch {}
  }
  child.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
}
