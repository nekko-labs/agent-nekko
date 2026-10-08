import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetName, localImages, mediaIndex, mediaTag, pickMediaRelease, rewriteImages, sha256 } from './pr-media.mjs';

const rel = (tag, n) => ({ tag_name: tag, assets: Array.from({ length: n }, (_, i) => ({ name: `a${i}.png` })) });
test('media releases form a pr-media, pr-media-2, ... series', () => {
  assert.equal(mediaTag(1), 'pr-media');
  assert.equal(mediaTag(2), 'pr-media-2');
  assert.throws(() => mediaTag(0));
  assert.equal(mediaIndex('pr-media'), 1);
  assert.equal(mediaIndex('pr-media-12'), 12);
  for (const t of ['pr-media-1', 'pr-media-x', 'v1.0.0', 'pr-media2']) assert.equal(mediaIndex(t), 0);
});
test('a batch goes to the newest release with room, else starts the next one', () => {
  assert.deepEqual(pickMediaRelease([], 3), { tag: 'pr-media', release: null });
  const one = rel('pr-media', 10);
  assert.equal(pickMediaRelease([one, rel('v1', 0)], 3).release, one);
  // Full: the whole batch must fit, so a nearly-full release is skipped too.
  assert.deepEqual(pickMediaRelease([rel('pr-media', 1000)], 1), { tag: 'pr-media-2', release: null });
  assert.deepEqual(pickMediaRelease([rel('pr-media', 990)], 36), { tag: 'pr-media-2', release: null });
  const two = rel('pr-media-2', 5);
  assert.equal(pickMediaRelease([two, rel('pr-media', 1000)], 36).release, two);
  assert.deepEqual(pickMediaRelease([rel('pr-media', 1000), rel('pr-media-2', 1000)], 1), { tag: 'pr-media-3', release: null });
});

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
