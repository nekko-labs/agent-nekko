// Produce a self-contained, publishable `agent-nekko` package under cli-dist/:
//   - index.mjs : the server + @agent-nekko/host/core/shared bundled by esbuild
//   - web/      : the built renderer (the UI)
//   - package.json : name "agent-nekko", bin aliases, and the few runtime deps
// Run after building the renderer (npm run build -w @agent-nekko/desktop).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, '..');
const repoRoot = resolve(serverDir, '../..');
const out = join(serverDir, 'cli-dist');

const renderer = join(repoRoot, 'apps/desktop/out/renderer');
if (!existsSync(join(renderer, 'index.html'))) {
  console.error('Build the renderer first: npm run build -w @agent-nekko/desktop');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Runtime deps stay external (installed by the consumer); everything else inlines.
const external = ['fastify', '@fastify/static', '@fastify/websocket'];

await build({
  entryPoints: [join(serverDir, 'src/index.ts')],
  outfile: join(out, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

cpSync(renderer, join(out, 'web'), { recursive: true });

const version = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version;
const pkg = {
  // `agent-nekko` is the thin CLI (apps/cli); this bundle is the self-hosted
  // web edition, a different artifact, so it publishes under its own name.
  name: 'agent-nekko-web',
  version,
  description: 'AI help on your computer: the self-hosted web edition plus CLI/MCP. Run with `npx agent-nekko-web`.',
  license: 'MIT',
  type: 'module',
  bin: { 'agent-nekko-web': 'index.mjs' },
  files: ['index.mjs', 'web'],
  engines: { node: '>=20' },
  dependencies: {
    '@fastify/static': '^8.0.3',
    '@fastify/websocket': '^11.0.1',
    fastify: '^5.1.0',
  },
};
writeFileSync(join(out, 'package.json'), JSON.stringify(pkg, null, 2));
writeFileSync(
  join(out, 'README.md'),
  '# Agent Nekko (web edition + CLI/MCP)\n\nWeb server:\n\n```bash\nnpx agent-nekko-web\n```\n\nThen open http://localhost:1440.\n\nCLI / MCP (drive your local agent from the terminal or other tools):\n\n```bash\nnpx agent-nekko-web status\nnpx agent-nekko-web chat "summarize README.md"\nnpx agent-nekko-web mcp        # MCP server on stdio (e.g. claude mcp add agent-nekko -- npx agent-nekko-web mcp)\n```\n\nSee https://github.com/nekko-labs/agent-nekko\n',
);

console.log(`\n✓ Bundled publishable package → ${out}`);
console.log('  Test:  cd cli-dist && npm install --omit=dev && node index.mjs');
console.log('  Publish:  cd cli-dist && npm publish');
