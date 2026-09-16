import { execFile } from 'child_process';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { EngineBuild, EngineInstall, EnginePlatform, GpuStats } from '@agent-nekko/shared';
import { buildsFor, hasBinaries, matchAsset, matchCompanion, recommendedBuild } from './builds.js';
import type { Downloads } from './download.js';

/**
 * Getting an engine onto the machine.
 *
 * Three ways in, in the order they are preferred: one we installed before, one
 * the user already has (on PATH or pointed at by hand), or one we download from
 * llama.cpp's own releases after the user says yes. Nothing multi-hundred-megabyte
 * happens without that yes, which is AN7's standing rule and the reason this is a
 * separate step rather than something the first Start button does quietly.
 */

/**
 * Recent releases, not `releases/latest`.
 *
 * llama.cpp's "latest" is a marker release carrying a single text file that
 * names the current nightly; the archives live on the `bNNNN` build tags behind
 * it. Asking for latest gets a release with no binaries in it, so we take the
 * first recent release that actually has some.
 */
const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const SERVER_NAMES = ['llama-server', 'llama-server.exe'];
/** Recorded beside the binary so a reinstall can tell what it is replacing. */
const RECORD_FILE = 'engine.json';

interface EngineRecord {
  binPath: string;
  backend: EngineBuild['backend'];
  buildId: string;
  version?: string;
  installedAt: number;
}

export interface EngineInstallerDeps {
  /** `<dataDir>/engine`, where managed builds land. */
  engineDir: () => string;
  downloads: Downloads;
  getGpuStats: () => Promise<GpuStats | null>;
  fetch?: typeof fetch;
  platform?: EnginePlatform;
  arch?: string;
  run?: (cmd: string, args: string[], timeoutMs?: number) => Promise<string | null>;
  /** A path the user chose by hand, checked before anything is downloaded. */
  externalPath?: () => string | undefined;
}

export function createEngineInstaller(deps: EngineInstallerDeps) {
  // `buildsFor` only knows the three platforms llama.cpp publishes for; anything
  // else finds no candidates and is told so, rather than being offered a build
  // that does not exist.
  const platform = deps.platform ?? (process.platform as EnginePlatform);
  const arch = deps.arch ?? process.arch;
  const doFetch = deps.fetch ?? globalThis.fetch;
  const run = deps.run ?? defaultRun;

  /** What is usable right now, and what we would install if asked. */
  async function detect(): Promise<EngineInstall> {
    const gpu = await deps.getGpuStats().catch(() => null);
    const available = buildsFor(platform, arch, gpu);
    const recommended = recommendedBuild(platform, arch, gpu);

    const external = deps.externalPath?.();
    if (external && (await isExecutable(external))) {
      return {
        binPath: external,
        source: 'external',
        version: await probeVersion(external),
        available,
        recommended,
      };
    }

    const record = await readRecord();
    if (record && (await isExecutable(record.binPath))) {
      return {
        binPath: record.binPath,
        source: 'managed',
        backend: record.backend,
        version: record.version,
        installedAt: record.installedAt,
        available,
        recommended,
      };
    }

    const onPath = await findOnPath();
    if (onPath) {
      return {
        binPath: onPath,
        source: 'external',
        version: await probeVersion(onPath),
        available,
        recommended,
      };
    }

    return {
      available,
      recommended,
      reason: recommended
        ? 'No engine installed yet. Agent Nekko can download one, or point it at a llama-server you already have.'
        : `No llama.cpp build is published for ${platform}/${arch}. Point Agent Nekko at a llama-server you built yourself.`,
    };
  }

  /**
   * Download and unpack a build. Returns the job id so the caller can follow it;
   * the install itself completes when the download does.
   */
  async function install(buildId?: string): Promise<{ ok: boolean; message: string; jobId?: string }> {
    const gpu = await deps.getGpuStats().catch(() => null);
    const build = buildId
      ? buildsFor(platform, arch, gpu).find((b) => b.id === buildId)
      : recommendedBuild(platform, arch, gpu);
    if (!build) return { ok: false, message: 'No engine build matches this machine.' };

    const release = await fetchRelease();
    if (!release) {
      return {
        ok: false,
        message: "Couldn't reach GitHub to find a llama.cpp release. Check the connection and try again.",
      };
    }
    const names = release.assets.map((a) => a.name);
    const assetName = matchAsset(build, names);
    if (!assetName) {
      return { ok: false, message: `The ${release.tag} release has no ${build.backend} build for this machine.` };
    }
    const asset = release.assets.find((a) => a.name === assetName)!;
    const companionName = matchCompanion(build, assetName, names);
    const companion = companionName ? release.assets.find((a) => a.name === companionName) : undefined;

    const dir = join(deps.engineDir(), build.id);
    const archivePath = join(dir, assetName);

    const job = await deps.downloads.start({
      id: `engine:${build.id}`,
      kind: 'engine',
      label: `llama.cpp ${release.tag} (${build.backend})`,
      target: build.id,
      url: asset.url,
      dest: archivePath,
      after: async (path) => {
        // The archive is the download; unpacking it is what makes it an engine,
        // so it happens here, inside the job, and a failure fails the job rather
        // than leaving a downloaded file nobody can use. It runs as `after`
        // rather than `verify` because extracting consumes the archive, and a
        // file consumed before the transfer has renamed it fails the rename.
        try {
          await extract(path, dir, run);
          if (companion) {
            // CUDA's runtime libraries ship separately and the server will not
            // start without them beside it.
            const companionPath = join(dir, companion.name);
            await downloadDirect(companion.url, companionPath, doFetch);
            await extract(companionPath, dir, run);
            await rm(companionPath, { force: true });
          }
          const bin = await findServerBinary(dir);
          if (!bin) return 'The archive did not contain llama-server.';
          if (platform !== 'win32') await chmod(bin, 0o755).catch(() => {});
          await writeRecord({
            binPath: bin,
            backend: build.backend,
            buildId: build.id,
            version: release.tag,
            installedAt: Date.now(),
          });
          return null;
        } catch (e) {
          return `Couldn't unpack the engine: ${(e as Error).message}`;
        }
      },
    });

    return { ok: true, message: `Downloading llama.cpp ${release.tag}.`, jobId: job.id };
  }

  /** Remove a managed install. An external binary is never touched. */
  async function uninstall(): Promise<{ ok: boolean; message: string }> {
    const record = await readRecord();
    if (!record) return { ok: false, message: 'No managed engine is installed.' };
    await rm(join(deps.engineDir(), record.buildId), { recursive: true, force: true });
    await rm(join(deps.engineDir(), RECORD_FILE), { force: true });
    return { ok: true, message: 'Removed the engine.' };
  }

  async function readRecord(): Promise<EngineRecord | null> {
    try {
      return JSON.parse(await readFile(join(deps.engineDir(), RECORD_FILE), 'utf8')) as EngineRecord;
    } catch {
      return null;
    }
  }

  async function writeRecord(record: EngineRecord): Promise<void> {
    await mkdir(deps.engineDir(), { recursive: true });
    await writeFile(join(deps.engineDir(), RECORD_FILE), JSON.stringify(record, null, 2), 'utf8');
  }

  async function fetchRelease(): Promise<{ tag: string; assets: Array<{ name: string; url: string }> } | null> {
    try {
      const res = await doFetch(RELEASES_API, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'agent-nekko' },
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{
        tag_name?: string;
        assets?: Array<{ name?: string; browser_download_url?: string }>;
      }>;
      if (!Array.isArray(rows)) return null;

      for (const row of rows) {
        const assets = (row.assets ?? [])
          .filter((a) => a.name && a.browser_download_url)
          .map((a) => ({ name: a.name as string, url: a.browser_download_url as string }));
        if (row.tag_name && hasBinaries(assets.map((a) => a.name))) {
          return { tag: row.tag_name, assets };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async function probeVersion(bin: string): Promise<string | undefined> {
    const out = await run(bin, ['--version'], 8000);
    return out?.match(/b(\d{3,})/)?.[0] ?? out?.match(/version[: ]+(\S+)/i)?.[1];
  }

  async function findOnPath(): Promise<string | null> {
    const finder = platform === 'win32' ? 'where' : 'which';
    for (const name of SERVER_NAMES) {
      const out = await run(finder, [name], 4000);
      const first = out?.split('\n').map((l) => l.trim()).find(Boolean);
      if (first && (await isExecutable(first))) return first;
    }
    return null;
  }

  return { detect, install, uninstall };
}

export type EngineInstaller = ReturnType<typeof createEngineInstaller>;

async function isExecutable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Depth-limited walk: the binary is a couple of levels down, never deeper. */
async function findServerBinary(dir: string, depth = 0): Promise<string | null> {
  if (depth > 3) return null;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && SERVER_NAMES.includes(entry.name)) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const hit = await findServerBinary(join(dir, entry.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Unpack an archive with whatever the OS already has.
 *
 * Node ships no zip reader and this is not worth a dependency: Windows 10+ and
 * macOS both carry bsdtar, which reads zip, and Linux has `unzip` for the zip
 * assets and tar for the tarballs. Each candidate is tried in turn and the first
 * that exits cleanly wins.
 */
async function extract(
  archive: string,
  dest: string,
  run: (cmd: string, args: string[], timeoutMs?: number) => Promise<string | null>,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const isTar = /\.(tar\.gz|tgz)$/i.test(archive);
  const attempts: Array<[string, string[]]> = isTar
    ? [['tar', ['-xzf', archive, '-C', dest]]]
    : [
        ['tar', ['-xf', archive, '-C', dest]],
        ['unzip', ['-o', '-q', archive, '-d', dest]],
        [
          'powershell',
          ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
        ],
      ];

  for (const [cmd, args] of attempts) {
    const out = await run(cmd, args, 300_000);
    if (out !== null) {
      await rm(archive, { force: true });
      return;
    }
  }
  throw new Error('no archive tool available (tried tar, unzip, PowerShell)');
}

/** A plain fetch-to-file, for the companion archive that has no job of its own. */
async function downloadDirect(url: string, dest: string, doFetch: typeof fetch): Promise<void> {
  const res = await doFetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`companion download failed (HTTP ${res.status})`);
  await mkdir(join(dest, '..'), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

function defaultRun(cmd: string, args: string[], timeoutMs = 10_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const text = `${stdout ?? ''}${stderr ?? ''}`;
      resolve(err ? null : text);
    });
  });
}
