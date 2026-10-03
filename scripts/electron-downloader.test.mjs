import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));

test('Builder downloader uses the cache-free downloader and validates artifacts', async () => {
  const get = builderRequire('@electron/get');
  assert.equal(typeof get.FetchDownloader, 'function');
  assert.equal(typeof get.downloadArtifact, 'function');
  assert.ok(get.ElectronDownloadCacheMode);
  const builder = require('app-builder-lib/out/util/electronGet.js');
  const data = Buffer.from('local downloader compatibility fixture');
  const hash = createHash('sha256').update(data).digest('hex');
  const name = 'electron-v43.7.7-win32-x64.zip';
  let requests = 0;
  let corruptChecksum = false;
  const server = createServer((req, res) => {
    if (!req.url.endsWith('SHASUMS256.txt')) requests++;
    const body = req.url.endsWith('SHASUMS256.txt') ? Buffer.from(`${corruptChecksum ? '0'.repeat(64) : hash} *${name}\n`) : data;
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cache = await mkdtemp(join(tmpdir(), 'nekko-downloader-'));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const options = {
      version: '43.7.7', platformName: 'win32', arch: 'x64', artifactName: 'electron',
      electronDownload: { cache, mirror: url, customDir: 'fixture' },
    };
    const file = await builder.downloadElectronArtifactZip(options);
    assert.deepEqual(await readFile(file), data);
    const before = requests;
    assert.equal(await builder.downloadElectronArtifactZip(options), file);
    assert.equal(requests, before, 'second download must use the validated artifact cache');
    corruptChecksum = true;
    await assert.rejects(builder.downloadElectronArtifactZip(options), /checksum/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(cache, { recursive: true, force: true });
  }
});
