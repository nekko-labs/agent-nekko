// Keep the downloaded runtime untouched: other worktrees may be using it.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const electron = require('electron');
if (process.env.ELECTRON_RUN_AS_NODE) throw new Error('Unset ELECTRON_RUN_AS_NODE before launching Agent Nekko');
const env = { ...process.env };
if (process.platform === 'darwin') {
  const cache = resolve('.dev-runtime', require('electron/package.json').version);
  const bundle = join(cache, 'Agent Nekko.app');
  const ready = join(cache, 'ready');
  if (!existsSync(ready)) {
    mkdirSync(cache, { recursive: true });
    cpSync(resolve(dirname(electron), '../..'), bundle, { recursive: true, verbatimSymlinks: true });
    const plist = join(bundle, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({ CFBundleName: 'Agent Nekko', CFBundleDisplayName: 'Agent Nekko', CFBundleIdentifier: 'com.agentnekko.desktop.dev' })) {
      const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
      if (result.status !== 0) spawnSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
    }
    const signed = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
    if (signed.status !== 0) throw new Error('Could not sign development bundle');
    writeFileSync(ready, 'signed');
  }
  // LaunchServices makes the app, not the terminal, the responsible process.
  const launcher = join(cache, 'launch.cjs');
  writeFileSync(launcher, `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');\nconst args=['-n','-W','-a',${JSON.stringify(bundle)}];\nfor(const key of ['PATH','HOME','ELECTRON_RENDERER_URL','NODE_ENV','NODE_ENV_ELECTRON_VITE']) if(process.env[key]) args.push('--env',key+'='+process.env[key]);\nargs.push('--args',...process.argv.slice(2).map(a=>a==='.'?process.cwd():a));\nconst child=spawn('/usr/bin/open',args,{stdio:'inherit'});\nchild.on('exit',code=>process.exit(code??1));\n`, { mode: 0o755 });
  env.ELECTRON_EXEC_PATH = launcher;
}
const cli = resolve(dirname(require.resolve('electron-vite')), '../bin/electron-vite.js');
const child = spawn(process.execPath, [cli, process.argv[2] || 'dev'], { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
