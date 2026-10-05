import type { ToolCall } from '@agent-nekko/shared';
import { ShieldIcon } from '../../icons.js';

export interface PendingApproval {
  call: ToolCall;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * The tool-approval prompt: the highest-stakes moment in the app, so it gets a
 * deliberate entrance without stealing focus from another chat. Y / N / Esc
 * keys apply only when the user focuses a control inside the approval prompt.
 */
export function ApprovalBar({ approval, onDecide }: { approval: PendingApproval; onDecide: (ok: boolean) => void }) {
  const color =
    approval.severity === 'high' ? 'var(--danger)' : approval.severity === 'medium' ? 'var(--warning)' : 'var(--ink-faint)';
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); onDecide(true); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); onDecide(false); }
  };
  return (
    <div
      className="slide-up border-t border-line px-5 py-3"
      style={{ background: 'var(--surface-2)' }}
      role="alertdialog"
      aria-label={`Approval required: ${approval.reason}`}
      onKeyDown={onKeyDown}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <ShieldIcon className="h-5 w-5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Approval required</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ background: color }}>{approval.severity}</span>
            <span className="text-[12px] text-ink-faint">{approval.reason}</span>
          </div>
          <code className="mt-0.5 block truncate font-mono text-[12px] text-ink-soft">
            {String((approval.call.input as Record<string, unknown>).command ?? JSON.stringify(approval.call.input))}
          </code>
        </div>
        <button className="btn btn-outline" onClick={() => onDecide(false)} title="Deny (N or Esc)">Deny</button>
        <button className="btn btn-primary" onClick={() => onDecide(true)} title="Approve (Y)">Approve</button>
      </div>
    </div>
  );
}
