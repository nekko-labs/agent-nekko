import type { DownloadJob } from '@agent-nekko/shared';
import { CloseIcon } from '../../icons.js';
import { formatBytes } from '../runtimes/verdict.js';

/**
 * What is coming down the wire.
 *
 * A model download is minutes to hours, so this has to answer "is it still
 * going" at a glance and "how much longer" on a second look. Cancel is always
 * available, because a 20 GB file started by mistake should not be something you
 * have to wait out.
 */

const STATE_LABEL: Record<DownloadJob['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  verifying: 'Checking the file',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function DownloadsPanel({ jobs, onChanged }: { jobs: DownloadJob[]; onChanged: () => void }) {
  if (jobs.length === 0) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-3.5 text-[12.5px] text-ink-faint" style={{ borderColor: 'var(--line)' }}>
        Nothing downloading. Anything you start from <strong>Find models</strong> shows its progress here.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {jobs.map((job) => {
        const pct =
          job.totalBytes && job.totalBytes > 0
            ? Math.min(100, (job.receivedBytes / job.totalBytes) * 100)
            : null;
        const active = job.state === 'downloading' || job.state === 'queued' || job.state === 'verifying';
        return (
          <div key={job.id} className="rounded-lg px-2.5 py-2" style={{ background: 'var(--surface-2)' }}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{job.label}</span>
              <span
                className="shrink-0 text-[11px]"
                style={{
                  color:
                    job.state === 'failed'
                      ? 'var(--danger)'
                      : job.state === 'done'
                        ? 'var(--success)'
                        : 'var(--ink-faint)',
                }}
              >
                {STATE_LABEL[job.state]}
              </span>
              <button
                className="btn btn-ghost shrink-0 px-1.5 py-1"
                title={active ? 'Cancel this download' : 'Remove from the list'}
                onClick={async () => {
                  if (active) await window.nekko.engineCancelDownload(job.id);
                  else await window.nekko.engineDismissDownload(job.id);
                  onChanged();
                }}
              >
                <CloseIcon className="h-3.5 w-3.5" />
              </button>
            </div>

            {active && (
              <div
                className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
                style={{ background: 'color-mix(in srgb, var(--ink-faint) 15%, transparent)' }}
              >
                <div
                  className="h-full rounded-full transition-[width]"
                  style={{
                    // An unknown total still shows motion rather than an empty
                    // bar, which otherwise reads as "stuck".
                    width: pct === null ? '35%' : `${pct}%`,
                    background: 'var(--accent)',
                    opacity: pct === null ? 0.5 : 1,
                  }}
                />
              </div>
            )}

            <p className="mt-1 text-[11px] text-ink-faint">
              {job.message ??
                [
                  `${formatBytes(job.receivedBytes)}${job.totalBytes ? ` of ${formatBytes(job.totalBytes)}` : ''}`,
                  job.bytesPerSecond ? `${formatBytes(job.bytesPerSecond)}/s` : null,
                  eta(job),
                ]
                  .filter(Boolean)
                  .join(' · ')}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Time left from the recent rate, omitted when either input is missing. */
function eta(job: DownloadJob): string | null {
  if (!job.totalBytes || !job.bytesPerSecond || job.bytesPerSecond < 1) return null;
  const seconds = (job.totalBytes - job.receivedBytes) / job.bytesPerSecond;
  if (seconds <= 0 || !Number.isFinite(seconds)) return null;
  if (seconds < 90) return `${Math.round(seconds)}s left`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m left`;
  return `${(seconds / 3600).toFixed(1)}h left`;
}
