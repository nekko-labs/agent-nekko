// Copy the built React renderer into the Capacitor web dir (apps/mobile/www).
// Run `npm run build -w @agent-nekko/desktop` first (the `build` script does both).
import { cpSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../desktop/out/renderer');
const dest = resolve(here, '../www');

if (!existsSync(src)) {
  console.error(`[mobile] Renderer not found at ${src}.\nBuild it first: npm run build -w @agent-nekko/desktop`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[mobile] Synced renderer → ${dest}`);
