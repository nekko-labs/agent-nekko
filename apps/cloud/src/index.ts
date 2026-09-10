import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { brandEnv } from '@agent-nekko/shared';
import { createCloudServer } from './server.js';
import { createBilling } from './billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.CLOUD_PORT ?? 4318);
const HOST = process.env.CLOUD_HOST ?? '127.0.0.1';
const isLocal = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
// Keeps an existing earlier-brand root if one is already there, same rule as
// the desktop/CLI data dir.
const DATA_ROOT =
  process.env.CLOUD_DATA_DIR ??
  ['.nekko-cloud', '.kotrain-cloud'].map((n) => join(homedir(), n)).find(existsSync) ??
  join(homedir(), '.nekko-cloud');

// Reuse the desktop-built renderer (same UI as every edition).
function findRendererDir(): string | undefined {
  const candidates = [
    brandEnv('RENDERER_DIR'),
    resolve(__dirname, 'web'),
    resolve(__dirname, '../../desktop/out/renderer'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, 'index.html')));
}

async function main() {
  const billing = createBilling();
  const { app } = createCloudServer({ dataRoot: DATA_ROOT, rendererDir: findRendererDir(), billing });
  await app.listen({ port: PORT, host: HOST });
  const url = `http://${isLocal ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nAgent Nekko Cloud running at ${url}`);
  console.log(`   data root: ${DATA_ROOT}`);
  console.log(`   accounts: sign up / log in at the URL above (per-account isolated data + plan entitlements)`);
  console.log(
    billing.enabled
      ? `   billing: Stripe enabled (plans: ${billing.availablePlans().join(', ') || 'none priced'})\n`
      : `   billing: disabled (set STRIPE_SECRET_KEY + STRIPE_PRICE_PRO/TEAM + STRIPE_WEBHOOK_SECRET to enable)\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
