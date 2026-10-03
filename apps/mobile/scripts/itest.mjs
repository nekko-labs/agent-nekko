// Runs the phone ↔ relay ↔ computer integration test (needs a root build).
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['vitest', 'run', 'src/lib/relay.itest.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEKKO_ITEST: '1' },
});
process.exit(r.status ?? 1);
