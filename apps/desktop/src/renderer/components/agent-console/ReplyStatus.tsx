import { formatRate } from '@agent-nekko/shared';
import { CheckIcon } from '../../icons.js';
import { MiniNekko } from '../Mascot.js';
import { fmtTok } from './transcript.js';

/** The watch deadline is an upper bound: PR changes may wake the chat sooner. */
export function sleepingLabel(nextWakeAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((nextWakeAt - now) / 60_000));
  const hours = Math.ceil(minutes / 60);
  return `Sleeping · will check in ${minutes > 60 ? `${hours} ${hours === 1 ? 'hour' : 'hours'}` : `${minutes} ${minutes === 1 ? 'min' : 'mins'}`}`;
}

/** Keep the measurements visible during generation and after completion. */
export function ReplyStatus({ streaming, status, elapsed, tps, out, last, done, nextWakeAt, now = Date.now(), blocked, estimatedRate = false }: {
  streaming: boolean; status: string; elapsed: number; tps: number; out: number;
  last: { out: number; tps: number; secs: number } | null;
  done?: string | null;
  nextWakeAt?: number | null;
  now?: number;
  blocked?: string | null;
  estimatedRate?: boolean;
}) {
  const measured = streaming ? { out, tps, secs: elapsed } : last;
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[12px] text-ink-faint" role="status">
      {streaming ? (
        <span className="flex items-center gap-2 text-ink-soft"><MiniNekko size={16} />{status || 'Working'}<span className="dots" /></span>
      ) : blocked ? (
        <span>{blocked}</span>
      ) : nextWakeAt != null ? (
        <span>{sleepingLabel(nextWakeAt, now)}</span>
      ) : (done || last) ? (
        <span className="flex items-center gap-1" title={done ?? undefined}><CheckIcon className="h-3 w-3" />Done.</span>
      ) : <span>Reply stats</span>}
      <span title={estimatedRate ? "Estimated tokens per second from streamed text and reasoning; replaced by provider usage when available" : "Output tokens per second while the model was generating"}>· {estimatedRate ? "~" : ""}{measured && measured.tps > 0 ? formatRate(measured.tps) : '—'} tok/s</span>
      <span>· {measured ? fmtTok(measured.out) : '—'} total tokens</span>
      <span>· {measured ? `${measured.secs}s` : 'Time unavailable'}</span>
    </div>
  );
}
