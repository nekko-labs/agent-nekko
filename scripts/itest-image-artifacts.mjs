import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = resolve('.');
const out = resolve('.shots/image-artifacts-fixture');
mkdirSync(out, { recursive: true });
const renderer = 'apps/desktop/src/renderer';
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'b2ae7a9', renderer], { encoding: 'utf8' }).trim().split('\n');
for (const f of files) { const p = resolve(out, 'baseline-source', f); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, execFileSync('git', ['show', `b2ae7a9:${f}`])); }
for (const version of ['baseline', 'after']) {
 const src = version === 'baseline' ? resolve(out, 'baseline-source', renderer) : resolve(renderer);
 const dir = resolve(out, version); mkdirSync(dir, { recursive: true });
 let fixture = readFileSync(resolve('scripts/itest-image-artifacts.fixture.tsx'), 'utf8').replaceAll('__SOURCE__', src.replaceAll('\\', '/'));
 writeFileSync(resolve(dir, 'fixture.tsx'), fixture);
 writeFileSync(resolve(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>');
 await build({ configFile: false, root: dir, base: './', plugins: [react()], resolve: { dedupe: ['react', 'react-dom'] }, css: { postcss: { plugins: [require('@tailwindcss/postcss')()] } }, build: { outDir: resolve(dir, 'dist'), chunkSizeWarningLimit: 3000 } });
}
const main = resolve(out, 'runner.cjs');
writeFileSync(main, readFileSync(resolve('scripts/itest-image-artifacts.electron.cjs')));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), [main, out], { windowsHide: true, stdio: 'inherit', env });
const timer = setTimeout(() => child.kill(), 90000);
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
