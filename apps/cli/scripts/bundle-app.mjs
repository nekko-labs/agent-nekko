// Produce the copy of the CLI that ships *inside* the desktop app.
//
// Different artifact from scripts/bundle.mjs (which builds the publishable npm
// package) in two ways that matter:
//
//   - CommonJS, because the app runs it through its own Electron binary with
//     ELECTRON_RUN_AS_NODE=1. That means the CLI works on a machine with no
//     Node and no npm at all, which is the whole point of shipping it.
//   - @lydell/node-pty is stubbed rather than left external. The in-app CLI has
//     no node_modules beside it to resolve a native module from, and it never
//     needs one: it has no terminal commands, and when it is driving the app
//     over HTTP the app owns the PTYs. Anything that does reach for one gets a
//     clear error instead of a module-not-found at startup.
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(here, '..');
const out = resolve(cliDir, 'app-dist');

mkdirSync(out, { recursive: true });

const stub = resolve(out, 'node-pty-stub.cjs');
writeFileSync(
  stub,
  `// Stands in for @lydell/node-pty inside the app-bundled CLI. See bundle-app.mjs.
const unavailable = () => {
  throw new Error(
    'Terminals are not available in the bundled CLI. Use the Agent Nekko app, or install the npm package: npm install -g agent-nekko',
  );
};
module.exports = { spawn: unavailable, open: unavailable };
`,
);

// src/version.ts reads ../package.json beside itself at runtime, which is fine
// in the npm package and wrong here: inside the app there is no package.json
// next to the bundle, and CommonJS has no import.meta to resolve it from. The
// version is known now, so it is baked in.
const { version } = JSON.parse(readFileSync(resolve(cliDir, 'package.json'), 'utf8'));
const inlineVersion = {
  name: 'inline-version',
  setup(b) {
    b.onLoad({ filter: /[\\/]src[\\/]version\.ts$/ }, () => ({
      contents: `export const VERSION = ${JSON.stringify(version)};\n`,
      loader: 'ts',
    }));
  },
};

await build({
  entryPoints: [resolve(cliDir, 'src/index.ts')],
  outfile: resolve(out, 'agent-nekko-cli.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  alias: { '@lydell/node-pty': stub },
  plugins: [inlineVersion],
  logLevel: 'info',
});

console.log(`\n✓ Bundled the in-app CLI → ${out}/agent-nekko-cli.cjs`);
