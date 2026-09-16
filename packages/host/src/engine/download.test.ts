import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DownloadJob } from '@agent-nekko/shared';
import { createDownloads } from './download.js';

/**
 * A model download is measured in gigabytes and minutes, which makes the
 * failure cases the interesting ones: a connection that drops, a server that
 * ignores a range request, a file that arrives corrupt, and a user who changes
 * their mind. Each one has a rule here, and each rule has a test.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nekko-dl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fetch that serves `body`, honouring Range when `supportsRange`. */
function serve(body: string, opts: { supportsRange?: boolean; status?: number } = {}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    if (opts.status && opts.status >= 400) {
      return new Response('nope', { status: opts.status });
    }
    const range = (init?.headers as Record<string, string> | undefined)?.Range;
    const from = opts.supportsRange && range ? Number(range.match(/bytes=(\d+)-/)?.[1] ?? 0) : 0;
    const slice = body.slice(from);
    return new Response(slice, {
      status: opts.supportsRange && range ? 206 : 200,
      headers: { 'content-length': String(Buffer.byteLength(slice)) },
    });
  }) as unknown as typeof fetch;
}

/** Resolve once the job reaches a terminal state. */
function settled(jobs: () => DownloadJob[], id: string): Promise<DownloadJob> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const job = jobs().find((j) => j.id === id);
      if (!job) return;
      if (['done', 'failed', 'cancelled'].includes(job.state)) {
        clearInterval(timer);
        resolve(job);
      }
    }, 10);
    setTimeout(() => {
      clearInterval(timer);
      reject(new Error('download never settled'));
    }, 5000);
  });
}

const request = (dest: string) => ({
  id: 'job-1',
  kind: 'model' as const,
  label: 'Test model',
  target: 'owner/repo',
  url: 'https://example.invalid/model.gguf',
  dest,
});

describe('downloads', () => {
  it('writes the file and reports done', async () => {
    const dest = join(dir, 'model.gguf');
    const downloads = createDownloads({ fetch: serve('hello world') });
    await downloads.start(request(dest));

    const job = await settled(downloads.list, 'job-1');
    expect(job.state).toBe('done');
    expect(await readFile(dest, 'utf8')).toBe('hello world');
  });

  it('leaves no .part file behind on success', async () => {
    const dest = join(dir, 'model.gguf');
    const downloads = createDownloads({ fetch: serve('hello') });
    await downloads.start(request(dest));
    await settled(downloads.list, 'job-1');

    await expect(stat(`${dest}.part`)).rejects.toThrow();
  });

  it('resumes from a partial file when the server honours Range', async () => {
    const dest = join(dir, 'model.gguf');
    // A previous attempt got the first five bytes before it was interrupted.
    await writeFile(`${dest}.part`, 'hello');
    const downloads = createDownloads({ fetch: serve('hello world', { supportsRange: true }) });
    await downloads.start(request(dest));

    await settled(downloads.list, 'job-1');
    expect(await readFile(dest, 'utf8')).toBe('hello world');
  });

  it('starts over when the server ignores Range, rather than corrupting the file', async () => {
    const dest = join(dir, 'model.gguf');
    await writeFile(`${dest}.part`, 'hello');
    // 200 with a full body after a Range request: appending would duplicate the
    // prefix and produce a file that looks complete and is not.
    const downloads = createDownloads({ fetch: serve('hello world', { supportsRange: false }) });
    await downloads.start(request(dest));

    await settled(downloads.list, 'job-1');
    expect(await readFile(dest, 'utf8')).toBe('hello world');
  });

  it('deletes the partial file when verification fails', async () => {
    const dest = join(dir, 'model.gguf');
    const downloads = createDownloads({ fetch: serve('not a gguf') });
    await downloads.start({ ...request(dest), verify: async () => 'The downloaded file is not a readable GGUF.' });

    const job = await settled(downloads.list, 'job-1');
    expect(job.state).toBe('failed');
    expect(job.message).toContain('GGUF');
    // Neither the final file nor a resumable stub survives a failed check.
    await expect(stat(dest)).rejects.toThrow();
    await expect(stat(`${dest}.part`)).rejects.toThrow();
  });

  it('explains an auth failure in terms of what to do about it', async () => {
    const downloads = createDownloads({ fetch: serve('', { status: 403 }) });
    await downloads.start(request(join(dir, 'model.gguf')));

    const job = await settled(downloads.list, 'job-1');
    expect(job.state).toBe('failed');
    expect(job.message).toMatch(/credentials or accepted terms/i);
  });

  it('reports other HTTP failures with their status', async () => {
    const downloads = createDownloads({ fetch: serve('', { status: 500 }) });
    await downloads.start(request(join(dir, 'model.gguf')));

    const job = await settled(downloads.list, 'job-1');
    expect(job.message).toContain('500');
  });

  it('cancels a job and leaves no finished file', async () => {
    const dest = join(dir, 'model.gguf');
    // A body that never ends, so there is something to cancel.
    const stalling = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            // deliberately never closed
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const downloads = createDownloads({ fetch: stalling });
    await downloads.start(request(dest));
    await new Promise((r) => setTimeout(r, 50));
    downloads.cancel('job-1');

    const job = await settled(downloads.list, 'job-1');
    expect(job.state).toBe('cancelled');
    await expect(stat(dest)).rejects.toThrow();
  });

  it('does not start a second job for something already downloading', async () => {
    const downloads = createDownloads({ fetch: serve('hello world') });
    const first = await downloads.start(request(join(dir, 'model.gguf')));
    const second = await downloads.start(request(join(dir, 'model.gguf')));
    expect(second.startedAt).toBe(first.startedAt);
    expect(downloads.list()).toHaveLength(1);
  });

  it('dismisses a finished job from the list', async () => {
    const downloads = createDownloads({ fetch: serve('hello') });
    await downloads.start(request(join(dir, 'model.gguf')));
    await settled(downloads.list, 'job-1');

    downloads.dismiss('job-1');
    expect(downloads.list()).toHaveLength(0);
  });

  it('publishes progress to the change listener', async () => {
    const seen: DownloadJob[][] = [];
    const downloads = createDownloads({ fetch: serve('hello world'), onChange: (jobs) => seen.push(jobs) });
    await downloads.start(request(join(dir, 'model.gguf')));
    await settled(downloads.list, 'job-1');

    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)?.[0].state).toBe('done');
  });
});

describe('post-download work', () => {
  it('runs `after` on the final path, and only once the file is in place', async () => {
    const dest = join(dir, 'engine.zip');
    let sawPath = '';
    const downloads = createDownloads({ fetch: serve('archive bytes') });
    await downloads.start({
      ...request(dest),
      after: async (path) => {
        sawPath = path;
        return null;
      },
    });

    const job = await settled(downloads.list, 'job-1');
    expect(job.state).toBe('done');
    // `verify` gets the .part; `after` gets the real thing, because unpacking an
    // archive that is about to be renamed is how the rename fails.
    expect(sawPath).toBe(dest);
  });

  it('lets `after` consume the file it was given', async () => {
    const dest = join(dir, 'engine.zip');
    const downloads = createDownloads({ fetch: serve('archive bytes') });
    await downloads.start({
      ...request(dest),
      // An extraction deletes the archive when it is done with it, which must not
      // be mistaken for a failed download.
      after: async (path) => {
        await rm(path, { force: true });
        return null;
      },
    });

    expect((await settled(downloads.list, 'job-1')).state).toBe('done');
  });

  it('fails the job and clears the file when `after` reports a problem', async () => {
    const dest = join(dir, 'engine.zip');
    const downloads = createDownloads({ fetch: serve('archive bytes') });
    await downloads.start({
      ...request(dest),
      after: async () => 'The archive did not contain llama-server.',
    });

    const job = await settled(downloads.list, 'job-1');
    expect(job.state).toBe('failed');
    expect(job.message).toContain('llama-server');
    await expect(stat(dest)).rejects.toThrow();
  });
});
