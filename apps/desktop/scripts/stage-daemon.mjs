// Build the engine daemon (nekkod) in release mode and stage it where
// electron-builder packs it (resources/bin -> <app>/resources/bin).
//
// `--optional` is for local runs (`npm run local`): without cargo it warns and
// exits 0, and the app runs the TS backend directly. Packaging never passes
// it, so an installer can never ship without its daemon by accident.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const optional = process.argv.includes('--optional');
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const exe = process.platform === 'win32' ? 'nekkod.exe' : 'nekkod';

// No shell: cargo is a real executable on every platform, and on Windows a
// shell reads the system Path rather than the PATH this process was given.
const cargo = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
if (cargo.status !== 0) {
  const msg = 'cargo not found: install Rust (https://rustup.rs) to build the engine daemon';
  if (optional) {
    console.warn(`${msg}; the app will run the TS backend without it.`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
}

execFileSync('cargo', ['build', '--release', '--locked', '-p', 'nekkod'], { cwd: repo, stdio: 'inherit' });

const built = join(repo, 'target', 'release', exe);
if (!existsSync(built)) {
  console.error(`expected ${built} after the build`);
  process.exit(1);
}
const dest = join(here, '..', 'resources', 'bin');
mkdirSync(dest, { recursive: true });
copyFileSync(built, join(dest, exe));
console.log(`staged ${exe} -> ${join(dest, exe)}`);
