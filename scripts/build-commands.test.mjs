import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('default build builds and stages nekkod before building the app', () => {
  assert.equal(pkg.scripts.build, 'npm run build:nekkod && npm run build:app');
  assert.equal(pkg.scripts['build:nekkod'], 'node apps/desktop/scripts/stage-daemon.mjs');
  assert.match(pkg.scripts['build:app'], /build:core/);
  assert.match(pkg.scripts['build:app'], /@agent-nekko\/host/);
  assert.match(pkg.scripts['build:app'], /build:app --workspace=apps\/cli/);
  assert.match(pkg.scripts['build:app'], /@agent-nekko\/desktop/);
  assert.doesNotMatch(pkg.scripts['build:app'], /cargo|stage-daemon|build:nekkod/);
});
