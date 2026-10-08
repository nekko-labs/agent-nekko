#!/usr/bin/env node
/** Publish local PR evidence to one shared GitHub release, never to git history. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MEDIA_TAG = 'pr-media';
/** GitHub caps a release at 1,000 assets; keep headroom for a whole PR's batch. */
export const MEDIA_ASSET_LIMIT = 1000;

/** The shared evidence releases in order: pr-media, pr-media-2, pr-media-3, ... */
export function mediaTag(index) {
  if (!Number.isInteger(index) || index < 1) throw new Error('Media release index must be a positive integer');
  return index === 1 ? MEDIA_TAG : `${MEDIA_TAG}-${index}`;
}

/** Which series index a tag is, or 0 when it is not a media release. */
export function mediaIndex(tag) {
  if (tag === MEDIA_TAG) return 1;
  const m = /^pr-media-(\d+)$/.exec(tag ?? '');
  return m && Number(m[1]) >= 2 ? Number(m[1]) : 0;
}

/**
 * Where a batch of `count` new assets goes: the newest media release while it
 * has room for the whole batch, else the next tag in the series (to create).
 */
export function pickMediaRelease(releases, count, limit = MEDIA_ASSET_LIMIT) {
  const series = releases.filter((r) => mediaIndex(r.tag_name) > 0).sort((a, b) => mediaIndex(a.tag_name) - mediaIndex(b.tag_name));
  const newest = series.at(-1);
  if (newest && newest.assets.length + count <= limit) return { tag: newest.tag_name, release: newest };
  return { tag: mediaTag(newest ? mediaIndex(newest.tag_name) + 1 : 1), release: null };
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function assetName(pr, file) {
  if (!/^\d+$/.test(String(pr)) || Number(pr) < 1) throw new Error('PR number must be positive');
  const name = basename(file.replaceAll('\\', '/'));
  if (!/^[\w.-]+\.(png|jpe?g|gif|webp|mp4|webm|svg)$/i.test(name)) {
    throw new Error(`Unsupported media filename: ${name}`);
  }
  return `pr-${pr}-${name}`;
}

/** Only markdown image destinations; ordinary links and remote URLs stay intact. */
export function localImages(body) {
  return [...body.matchAll(/!\[[^\]]*\]\(([^\n)]+)\)/g)]
    .map((m) => m[1]).filter((p) => !/^(https?:|data:)/i.test(p));
}

export function rewriteImages(body, urls) {
  return body.replace(/(!\[[^\]]*\]\()([^\n)]+)(\))/g,
    (all, start, path, end) => urls.has(path) ? `${start}${urls.get(path)}${end}` : all);
}

export async function upload(pr, repo) {
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const api = (endpoint) => JSON.parse(gh('api', endpoint));
  repo ??= JSON.parse(gh('repo', 'view', '--json', 'nameWithOwner')).nameWithOwner;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Expected owner/repo');
  assetName(pr, 'validate.png');
  const getPr = () => api(`repos/${repo}/pulls/${pr}`);
  const initial = getPr();
  const paths = [...new Set(localImages(initial.body ?? ''))];
  if (!paths.length) { console.log('No local markdown images to upload.'); return; }
  // Read and validate all files before making remote changes.
  const files = paths.map((path) => ({ path, name: assetName(pr, path), bytes: readFileSync(resolve(path)) }));
  if (new Set(files.map((f) => f.name)).size !== files.length) throw new Error('Duplicate basenames; rename files before uploading');
  const releases = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`)).flat();
  // An asset already published (in any media release) is reused and verified, never re-uploaded.
  const published = new Map(releases.filter((r) => mediaIndex(r.tag_name) > 0).flatMap((r) => r.assets.map((a) => [a.name, a])));
  const fresh = files.filter((f) => !published.has(f.name));
  let { tag, release } = pickMediaRelease(releases, fresh.length);
  if (!release && fresh.length) {
    gh('release', 'create', tag, '--repo', repo, '--target', 'main', '--prerelease', '--latest=false',
      '--title', tag === MEDIA_TAG ? 'Pull request visual evidence' : `Pull request visual evidence (${tag})`, '--notes',
      'Screenshots and recordings for pull requests. Not a software release. Keep assets to preserve historical links.');
    release = api(`repos/${repo}/releases/tags/${tag}`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'pr-media-'));
  const urls = new Map();
  try {
    for (const file of files) {
      let asset = published.get(file.name) ?? release?.assets.find((a) => a.name === file.name);
      if (!asset) {
        const staged = join(scratch, file.name);
        writeFileSync(staged, file.bytes);
        gh('release', 'upload', tag, staged, '--repo', repo);
        release = api(`repos/${repo}/releases/tags/${tag}`);
        asset = release.assets.find((a) => a.name === file.name);
      }
      if (!asset) throw new Error(`Upload missing: ${file.name}`);
      const downloaded = execFileSync('gh', ['api', `repos/${repo}/releases/assets/${asset.id}`,
        '-H', 'Accept: application/octet-stream'], { maxBuffer: 128 * 1024 * 1024 });
      if (sha256(downloaded) !== sha256(file.bytes)) {
        throw new Error(`Existing asset differs: ${file.name}. Use a new filename; historical evidence is immutable.`);
      }
      const response = await fetch(asset.browser_download_url);
      if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== sha256(file.bytes)) {
        throw new Error(`Public asset URL failed verification: ${file.name}`);
      }
      urls.set(file.path, asset.browser_download_url);
      console.log(`Verified ${asset.browser_download_url}`);
    }
    // Refetch so unrelated edits made while uploading are preserved.
    const current = getPr();
    const body = rewriteImages(current.body ?? '', urls);
    if (body !== current.body) {
      const payload = join(scratch, 'body.json');
      writeFileSync(payload, JSON.stringify({ body }));
      gh('api', '--method', 'PATCH', `repos/${repo}/pulls/${pr}`, '--input', payload);
      if (getPr().body !== body) throw new Error('PR body update did not persist; inspect concurrent edits');
      console.log(`Updated PR #${pr}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [pr, repo] = process.argv.slice(2);
  if (!pr) { console.error('Usage: node scripts/pr-media.mjs <PR number> [owner/repo]'); process.exitCode = 1; }
  else { try { await upload(pr, repo); } catch (error) { console.error(error.message); process.exitCode = 1; } }
}
