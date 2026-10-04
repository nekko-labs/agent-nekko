import { useEffect, useRef, useState } from 'react';
import type { ToolCall } from '@agent-nekko/shared';
import { ShieldIcon } from '../../icons.js';
import type { ApprovalScope } from './approval-decision.js';

export interface PendingApproval {
  call: ToolCall;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/** Tool approval keeps Deny focused by default; Y approves only this call. */
export function ApprovalBar({ approval, onDecide }: { approval: PendingApproval; onDecide: (ok: boolean, scope?: ApprovalScope) => Promise<void> }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  const deciding = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { denyRef.current?.focus(); }, []);
  const decide = async (ok: boolean, scope: ApprovalScope = 'once') => {
    if (deciding.current) return;
    deciding.current = true;
    setBusy(true);
    setError(null);
    try { await onDecide(ok, scope); }
    catch (e) { setError((e as Error).message); }
    finally { deciding.current = false; setBusy(false); }
  };
  const color =
    approval.severity === 'high' ? 'var(--danger)' : approval.severity === 'medium' ? 'var(--warning)' : 'var(--ink-faint)';
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); void decide(true); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); void decide(false); }
  };
  const buttonClass = 'btn h-7 px-3! py-0! text-[12px]! disabled:opacity-50';
  return (
    <div
      className="slide-up border-t border-line px-5 py-3"
      style={{ background: 'var(--surface-2)' }}
      role="alertdialog"
      aria-label={`Approval required: ${approval.reason}`}
      aria-busy={busy}
      onKeyDown={onKeyDown}
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <ShieldIcon className="h-5 w-5" />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold">Approval required</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ background: color }}>{approval.severity}</span>
            <span className="text-[12px] text-ink-faint">{approval.reason}</span>
          </div>
          <code className="mt-0.5 block truncate font-mono text-[12px] text-ink-soft">
            {String((approval.call.input as Record<string, unknown>).command ?? JSON.stringify(approval.call.input))}
          </code>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button ref={denyRef} disabled={busy} className={`${buttonClass} btn-outline`} onClick={() => void decide(false)} title="Deny (N or Esc)">Deny</button>
          <button disabled={busy} className={`${buttonClass} btn-primary`} onClick={() => void decide(true)} title="Approve (Y)">Approve</button>
          <button disabled={busy} className={`${buttonClass} btn-outline`} onClick={() => void decide(true, 'session')} title="Allow all for the rest of this chat (YOLO). Deny rules still block.">Allow all this session</button>
          <button disabled={busy} className={`${buttonClass} btn-outline`} onClick={() => void decide(true, 'always')} title="Allow all in this chat and set Settings → Chat modes to YOLO for new chats. Deny rules still block.">Always allow all</button>
        </div>
      </div>
      {error && <p role="alert" className="mx-auto mt-2 max-w-5xl text-[12px] text-(--danger)">{error}</p>}
    </div>
  );
}
