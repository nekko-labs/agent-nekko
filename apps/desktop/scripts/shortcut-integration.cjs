const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../../..');
const out = path.join(repo, '.shots/shortcut-integration');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  await require('esbuild').build({ entryPoints: [path.join(__dirname, 'shortcut-fixture.tsx')], bundle: true, jsx: 'automatic', conditions: ['browser', 'import', 'default'], format: 'iife', outfile: path.join(out, 'fixture.js'), alias: { '@agent-nekko/shared': path.join(repo, 'packages/shared/src/index.ts') }, loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl', '.wasm': 'file' } });
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'"><div id="root"></div><script src="fixture.js"></script>`);
  const env = { ...process.env, NEKKO_SHORTCUT_OUT: out }; delete env.ELECTRON_RUN_AS_NODE;
  const result = cp.spawnSync(require('electron'), [path.join(__dirname, 'shortcut-sandbox.cjs')], { cwd: repo, env, windowsHide: true, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
