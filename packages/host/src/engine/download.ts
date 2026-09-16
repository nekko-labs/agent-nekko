import { createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { DownloadJob, DownloadState } from '@agent-nekko/shared';

/**
 * The download queue behind both acquisitions: engine builds and model files.
 *
 * Three properties matter more than anything clever here. It **resumes**, because
 * a 20 GB model over a domestic connection will be interrupted and starting over
 * is not an acceptable answer. It **cancels for real**, aborting the request
 * rather than letting it finish in the background. And it writes to `<file>.part`
 * and renames only on success, so a killed app never leaves a truncated GGUF that
 * looks like a working one.
 */

/** How often progress is published. Faster than this is just re-rendering. */
const PROGRESS_INTERVAL_MS = 400;
/** Window for the rate estimate, long enough not to jitter with the buffers. */
const RATE_WINDOW_MS = 3000;

export interface DownloadRequest {
  id: string;
  kind: 'model' | 'engine';
  label: string;
  target: string;
  url: string;
  /** Final path. The transfer writes `<dest>.part` until it succeeds. */
  dest: string;
  headers?: Record<string, string>;
  /** Called after the bytes land, before the job reports `done`. */
  verify?: (path: string) => Promise<string | null>;
}

export interface DownloadsDeps {
  fetch?: typeof fetch;
  onChange?: (jobs: DownloadJob[]) => void;
}

interface ActiveJob extends DownloadJob {
  controller: AbortController;
  rateSamples: Array<{ at: number; bytes: number }>;
  /**
   * The response body, while one is in flight. Cancel destroys this directly
   * rather than trusting the abort signal to reach it: aborting the request is
   * the polite half, and tearing down the stream is what actually stops bytes
   * landing on disk.
   */
  body?: Readable;
}

export function createDownloads(deps: DownloadsDeps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const jobs = new Map<string, ActiveJob>();
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshot(): DownloadJob[] {
    return [...jobs.values()].map(strip).sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Coalesce notifications: a fast link would otherwise emit per chunk. */
  function notify(immediate = false): void {
    if (immediate) {
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
      deps.onChange?.(snapshot());
      return;
    }
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      deps.onChange?.(snapshot());
    }, PROGRESS_INTERVAL_MS);
    notifyTimer.unref?.();
  }

  function settle(job: ActiveJob, state: DownloadState, message?: string): void {
    job.state = state;
    job.message = message;
    job.finishedAt = Date.now();
    job.bytesPerSecond = undefined;
    notify(true);
  }

  async function start(req: DownloadRequest): Promise<DownloadJob> {
    const existing = jobs.get(req.id);
    if (existing && (existing.state === 'downloading' || existing.state === 'queued')) return strip(existing);

    const job: ActiveJob = {
      id: req.id,
      kind: req.kind,
      label: req.label,
      target: req.target,
      state: 'queued',
      receivedBytes: 0,
      startedAt: Date.now(),
      controller: new AbortController(),
      rateSamples: [],
    };
    jobs.set(req.id, job);
    notify(true);

    // Deliberately not awaited: the caller gets the job back immediately and
    // follows it through the change events.
    void run(req, job).catch((e: Error) => settle(job, 'failed', e.message));
    return strip(job);
  }

  async function run(req: DownloadRequest, job: ActiveJob): Promise<void> {
    const partial = `${req.dest}.part`;
    await mkdir(dirname(req.dest), { recursive: true });

    // Resume from whatever a previous attempt managed to write.
    const already = await stat(partial).then((s) => s.size).catch(() => 0);
    const headers: Record<string, string> = { ...req.headers };
    if (already > 0) headers['Range'] = `bytes=${already}-`;

    job.state = 'downloading';
    job.receivedBytes = already;
    notify(true);

    const res = await doFetch(req.url, { headers, signal: job.controller.signal, redirect: 'follow' });
    // 206 means the server honoured the range; 200 with a range asked means it
    // did not, so the bytes we have are worthless and we start again.
    const resuming = res.status === 206;
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? 'This file needs credentials or accepted terms on its page before it can be downloaded.'
          : `The download failed (HTTP ${res.status}).`,
      );
    }
    if (already > 0 && !resuming) job.receivedBytes = 0;

    const lengthHeader = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(lengthHeader) && lengthHeader > 0) {
      job.totalBytes = job.receivedBytes + lengthHeader;
    }
    if (!res.body) throw new Error('The server sent no data.');

    const out = createWriteStream(partial, { flags: resuming && already > 0 ? 'a' : 'w' });
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    job.body = body;
    body.on('data', (chunk: Buffer) => {
      job.receivedBytes += chunk.length;
      sampleRate(job);
      notify();
    });

    try {
      await pipeline(body, out);
    } catch (e) {
      if (job.controller.signal.aborted) {
        settle(job, 'cancelled', 'Cancelled.');
        return;
      }
      throw e;
    } finally {
      job.body = undefined;
    }

    if (req.verify) {
      job.state = 'verifying';
      notify(true);
      const problem = await req.verify(partial);
      if (problem) {
        // A file that failed its check is worse than no file: delete it so a
        // retry cannot resume onto corrupt bytes.
        await rm(partial, { force: true });
        throw new Error(problem);
      }
    }

    await rm(req.dest, { force: true });
    await rename(partial, req.dest);
    settle(job, 'done');
  }

  /** Bytes per second over the recent window, not over the whole transfer. */
  function sampleRate(job: ActiveJob): void {
    const now = Date.now();
    job.rateSamples.push({ at: now, bytes: job.receivedBytes });
    while (job.rateSamples.length > 1 && now - job.rateSamples[0].at > RATE_WINDOW_MS) {
      job.rateSamples.shift();
    }
    const first = job.rateSamples[0];
    const span = now - first.at;
    if (span > 500) job.bytesPerSecond = ((job.receivedBytes - first.bytes) * 1000) / span;
  }

  function cancel(id: string): void {
    const job = jobs.get(id);
    if (!job) return;
    job.controller.abort();
    job.body?.destroy(new Error('cancelled'));
    if (job.state === 'queued') settle(job, 'cancelled', 'Cancelled.');
  }

  /** Drop a finished job from the list. A running one is cancelled first. */
  function dismiss(id: string): void {
    const job = jobs.get(id);
    if (!job) return;
    if (job.state === 'downloading' || job.state === 'queued') {
      job.controller.abort();
      job.body?.destroy(new Error('cancelled'));
    }
    jobs.delete(id);
    notify(true);
  }

  return {
    start,
    cancel,
    dismiss,
    list: snapshot,
    isActive: (id: string) => {
      const s = jobs.get(id)?.state;
      return s === 'downloading' || s === 'queued' || s === 'verifying';
    },
  };
}

export type Downloads = ReturnType<typeof createDownloads>;

function strip(job: ActiveJob): DownloadJob {
  const { controller: _c, rateSamples: _r, body: _b, ...rest } = job;
  return rest;
}
