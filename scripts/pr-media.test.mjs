import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetName, localImages, rewriteImages, sha256 } from './pr-media.mjs';

test('media names are PR-scoped across Windows and Unix paths', () => {
  assert.equal(assetName(305, 'C:\\shots\\after.png'), 'pr-305-after.png');
  assert.equal(assetName(305, '/tmp/after.gif'), 'pr-305-after.gif');
  for (const p of ['../payload.exe', 'space name.png', 'photo.png#label']) assert.throws(() => assetName(305, p));
  assert.throws(() => assetName(0, 'after.png'));
});
test('finds only local markdown images and does not rewrite ordinary links', () => {
  const body = '![Before](C:/shots/before.png) ![After](/tmp/after.gif) ![Remote](https://host/a.png) [File](/tmp/after.gif)';
  assert.deepEqual(localImages(body), ['C:/shots/before.png', '/tmp/after.gif']);
  const changed = rewriteImages(body, new Map([['/tmp/after.gif', 'https://github.com/release/after.gif']]));
  assert.ok(changed.includes('![After](https://github.com/release/after.gif)'));
  assert.ok(changed.includes('[File](/tmp/after.gif)'));
  assert.ok(changed.includes('![Before](C:/shots/before.png)'));
});
test('hashes binary bytes without encoding loss', () => {
  assert.equal(sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(sha256(Buffer.from([0, 255])), sha256(Buffer.from([0, 254])));
});
