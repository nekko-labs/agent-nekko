import { formatRate } from '@agent-nekko/shared';
import { CheckIcon } from '../../icons.js';
import { MiniNekko } from '../Mascot.js';
import { fmtTok } from './transcript.js';

/** Keep the measurements visible during generation and after completion. */
export function ReplyStatus({ streaming, status, elapsed, tps, out, last, done }: {
  streaming: boolean; status: string; elapsed: number; tps: number; out: number;
  last: { out: number; tps: number; secs: number } | null;
  done?: string | null;
}) {
  const measured = streaming ? { out, tps, secs: elapsed } : last;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[12px] text-ink-faint" role="status">
      {streaming ? (
        <span className="flex items-center gap-2 text-ink-soft"><MiniNekko size={16} />{status || 'Working'}<span className="dots" /></span>
      ) : (done || last) ? (
        <span className="flex items-center gap-1" title={done ?? undefined}><CheckIcon className="h-3 w-3" />Done.</span>
      ) : <span>Reply stats</span>}
      <span title="Output tokens per second while the model was generating">· {measured && measured.tps > 0 ? formatRate(measured.tps) : '—'} tok/s</span>
      <span>· {measured ? fmtTok(measured.out) : '—'} total tokens</span>
      <span>· {measured ? `${measured.secs}s` : 'Time unavailable'}</span>
    </div>
  );
}
