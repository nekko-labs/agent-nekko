import React, { useEffect, useMemo, useState } from 'react';
import type { PrInfo, PrAction, PrDiff, PrChecks } from '@agent-nekko/shared';
import { parsePrUrl } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { BranchIcon, CheckIcon, CloseIcon } from '../icons.js';

/** Summarise a chat's PRs for the sidebar/header badges. */
export function prSummary(prs: PrInfo[]) {
  const open = prs.filter((p) => p.state === 'open');
  const merged = prs.filter((p) => p.state === 'merged').length;
  const closed = prs.filter((p) => p.state === 'closed').length;
  const ready = open.some((p) => p.reviewDecision === 'APPROVED' && p.checks !== 'failing');
  return { open: open.length, merged, closed, ready, total: prs.length };
}

const CHECK_META: Record<PrChecks, { label: string; color: string; dot: string }> = {
  passing: { label: 'checks passing', color: 'var(--success)', dot: '✓' },
  failing: { label: 'checks failing', color: 'var(--danger)', dot: '✕' },
  pending: { label: 'checks running', color: 'var(--warning)', dot: '●' },
  none: { label: '', color: '', dot: '' },
};

const openExternally = (url: string) => window.nekko.openPath(url).catch(() => {});

/** A few drifting stars for the merged-PR celebration background. */
function Stars() {
  const stars = [
    { top: '18%', left: '8%', s: 7, d: '0s' },
    { top: '62%', left: '18%', s: 5, d: '.7s' },
    { top: '30%', left: '46%', s: 6, d: '1.3s' },
    { top: '72%', left: '63%', s: 5, d: '.4s' },
    { top: '22%', left: '82%', s: 7, d: '1s' },
    { top: '55%', left: '92%', s: 5, d: '1.6s' },
  ];
  return (
    <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {stars.map((st, i) => (
        <span
          key={i}
          className="absolute animate-pulse text-violet-200"
          style={{ top: st.top, left: st.left, fontSize: st.s, opacity: 0.5, animationDelay: st.d, animationDuration: '2.4s' }}
        >
          ✦
        </span>
      ))}
    </span>
  );
}

/**
 * A PR surfaced inline in the chat. When the PR is still open it offers the
 * primary actions (approve / decline / review) plus a subtle merge; once merged
 * it turns into a purple, star-dusted "successfully merged" banner.
 */
export function PrCard({ url, info, sessionId }: { url: string; info?: PrInfo; sessionId?: string }) {
  const parsed = parsePrUrl(url);
  const openPrPane = useStore((s) => s.openPrPane);
  const [busy, setBusy] = useState<PrAction | null>(null);
  const [confirm, setConfirm] = useState<PrAction | null>(null);

  const label = info
    ? `${info.owner}/${info.repo}#${info.number}`
    : parsed
      ? `${parsed.owner}/${parsed.repo}#${parsed.number}`
      : url;
  const state = info?.state ?? 'open';
  const merged = state === 'merged';
  const closed = state === 'closed';

  const act = async (action: PrAction) => {
    if (confirm !== action) { setConfirm(action); return; }
    setConfirm(null);
    setBusy(action);
    try {
      const res = await window.nekko.prAction(url, action);
      useStore.getState().pushToast(res.ok ? 'success' : 'error', res.message);
      if (sessionId) await useStore.getState().refreshSessionPrs(sessionId);
    } catch (e) {
      useStore.getState().pushToast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const cta = (action: PrAction, fallback: string) => (busy === action ? '…' : confirm === action ? 'Confirm?' : fallback);

  if (merged) {
    return (
      <div
        className="fade-in relative my-2 overflow-hidden rounded-xl border px-4 py-3"
        style={{ borderColor: 'rgba(168,85,247,0.45)', background: 'linear-gradient(270deg, rgba(147,51,234,0.38) 0%, rgba(88,28,135,0.14) 70%, transparent 100%)' }}
      >
        <Stars />
        <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1">
          <button className="font-mono text-[12px] font-medium text-violet-100 hover:underline" onClick={() => openExternally(url)} title="Open on GitHub">
            {label}
          </button>
          {info?.title && <span className="min-w-0 flex-1 truncate text-[12.5px] text-violet-50/90">{info.title}</span>}
          <span className="ml-auto flex items-center gap-1.5 text-[12.5px] font-semibold text-violet-100">
            Successfully merged <span>🎉</span>
          </span>
        </div>
      </div>
    );
  }

  const check = info ? CHECK_META[info.checks] : CHECK_META.none;
  const actionClass = 'inline-flex h-6 items-center rounded-md px-2 text-[11px] font-medium transition-colors enabled:hover:bg-surface disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
  return (
    <div className="fade-in relative my-2 overflow-hidden rounded-xl px-4 py-3" style={{ background: 'linear-gradient(270deg, color-mix(in srgb, var(--ink) 5%, transparent), transparent)' }}>
      {/* Info on the left, actions parked on the right so the card stays slim. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`shrink-0 text-[13px] ${closed ? 'text-red-400' : 'text-green-400'}`}>⑂</span>
            <button className="min-w-0 truncate font-mono text-[12px] font-medium hover:underline" onClick={() => openExternally(url)} title={`${label}${info?.headRefName ? ` · ${info.headRefName} → ${info.baseRefName ?? 'main'}` : ''} · Open on GitHub`}>
              {info?.headRefName ?? label}
            </button>
            <span
              className="shrink-0 text-[10px] font-medium"
              style={{ color: closed ? 'var(--ink-faint)' : info?.isDraft ? 'var(--neutral)' : 'var(--success)' }}
            >
              {closed ? 'closed' : info?.isDraft ? 'draft' : 'open'}
            </span>
            {info && (info.additions > 0 || info.deletions > 0) && (
              <span className="shrink-0 text-[11px]">
                <span className="text-green-500">+{info.additions}</span> <span className="text-red-400">-{info.deletions}</span>
              </span>
            )}
            {check.dot && (
              <span className="shrink-0 text-[11px]" style={{ color: check.color }} title={check.label}>{check.dot} {check.label}</span>
            )}
            {info?.reviewDecision === 'APPROVED' && <span className="shrink-0 text-[11px] text-green-400" title="Approved">✓ approved</span>}
          </div>
          {info?.title && <div className="truncate pt-1 text-[13px]">{info.title}</div>}
          {info?.headRefName && (
            <div className="truncate pt-0.5 font-mono text-[10.5px] text-ink-faint">{label} · → {info.baseRefName ?? 'main'}</div>
          )}
        </div>

        {/* Modern action cluster, right-aligned. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {!closed && (
            <button
              className={actionClass}
              style={{ color: 'var(--success)' }}
              onClick={() => act('approve')}
              disabled={!!busy}
              title="Approve this PR (with auto-merge on, this lands it once checks pass)"
            >
              {cta('approve', 'Approve')}
            </button>
          )}
          {!closed && (
            <button
              className={actionClass}
              style={{ color: 'color-mix(in srgb, var(--danger) 85%, transparent)' }}
              onClick={() => act('close')}
              disabled={!!busy}
              title="Close this PR without merging"
            >
              {cta('close', 'Decline')}
            </button>
          )}
          {closed && (
            <button
              className={actionClass}
              onClick={() => act('reopen')}
              disabled={!!busy}
            >
              {cta('reopen', 'Reopen')}
            </button>
          )}
          <button
            className={actionClass}
            onClick={() => openPrPane(url)}
            title="Review the diff in a side pane"
          >
            Review
          </button>
          {!closed && (
            <button
              className={`${actionClass} text-ink-soft`}
              onClick={() => act('merge')}
              disabled={!!busy}
              title="Merge this PR now (merge commit)"
            >
              {cta('merge', 'Merge')}
            </button>
          )}
          <button
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint transition hover:bg-surface hover:text-ink"
            onClick={() => openExternally(url)}
            title="Open on GitHub"
            aria-label="Open on GitHub"
          >
            ↗
          </button>
        </div>
      </div>
    </div>
  );
}

/** One line of a unified-diff hunk. */
function patchLines(patch: string) {
  return patch.split('\n').map((line, i) => {
    let color: string | undefined;
    let bg: string | undefined;
    if (line.startsWith('@@')) color = 'var(--accent)';
    else if (line.startsWith('+')) { color = 'var(--success)'; bg = 'color-mix(in srgb, var(--success) 10%, transparent)'; }
    else if (line.startsWith('-')) { color = 'var(--danger)'; bg = 'color-mix(in srgb, var(--danger) 10%, transparent)'; }
    return (
      <div key={i} className="flex" style={{ background: bg }}>
        <span className="whitespace-pre-wrap wrap-break-word px-3" style={{ color: color ?? 'var(--ink-soft)' }}>{line || ' '}</span>
      </div>
    );
  });
}

/** The PR diff, shown as a workbench side pane (read-only, Devin-style). */
export function PrPane({ url }: { url: string }) {
  const [diff, setDiff] = useState<PrDiff | null>(null);
  const [loaded, setLoaded] = useState(false);
  const parsed = parsePrUrl(url);
  const label = parsed ? `${parsed.owner}/${parsed.repo}#${parsed.number}` : url;

  useEffect(() => {
    setLoaded(false);
    window.nekko.getPrDiff(url).then((d) => { setDiff(d); setLoaded(true); }).catch(() => setLoaded(true));
  }, [url]);

  const totals = useMemo(() => {
    const files = diff?.files ?? [];
    return {
      files: files.length,
      adds: files.reduce((n, f) => n + f.additions, 0),
      dels: files.reduce((n, f) => n + f.deletions, 0),
    };
  }, [diff]);

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-[12px]">
        <span className="shrink-0 text-green-400">⑂</span>
        <span className="truncate font-semibold">{label}</span>
        {loaded && (
          <span className="shrink-0 text-[10.5px]">
            <span className="text-green-500">+{totals.adds}</span> <span className="text-red-400">-{totals.dels}</span> · {totals.files} file{totals.files === 1 ? '' : 's'}
          </span>
        )}
        <button className="ml-auto shrink-0 text-[11px] text-ink-faint hover:text-ink" onClick={() => openExternally(url)}>Open on GitHub ↗</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {!loaded ? (
          <p className="p-4 text-[12px] text-ink-faint">Loading diff…</p>
        ) : !diff || diff.files.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-[13px] text-ink-faint">
            Couldn't load the diff. The PR may be private, or gh/GitHub isn't reachable — open it on GitHub instead.
          </div>
        ) : (
          <>
            {diff.files.map((f) => <PrFileDiff key={f.path} file={f} />)}
            {diff.truncated && <p className="p-3 text-[11px] text-ink-faint">Diff truncated (large PR). Open on GitHub for the full change.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function PrFileDiff({ file }: { file: PrDiff['files'][number] }) {
  const [open, setOpen] = useState(true);
  const name = file.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || file.path;
  return (
    <div className="border-b border-line">
      <button className="sticky top-0 z-10 flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]" style={{ background: 'var(--surface-2)' }} onClick={() => setOpen((o) => !o)}>
        <span className="w-2 text-[9px] text-ink-faint">{open ? '▾' : '▸'}</span>
        <span className="truncate font-medium" title={file.path}>{name}</span>
        {file.status !== 'modified' && <span className="chip text-[9px] uppercase">{file.status}</span>}
        <span className="ml-auto shrink-0 text-[10px]"><span className="text-green-500">+{file.additions}</span> <span className="text-red-400">-{file.deletions}</span></span>
      </button>
      {open && (
        file.patch ? (
          <div className="font-mono text-[12px] leading-relaxed">{patchLines(file.patch)}</div>
        ) : (
          <p className="px-3 py-2 text-[11px] text-ink-faint">No inline patch (binary or too large).</p>
        )
      )}
    </div>
  );
}

/** Compact PR status badge for chat rows and the chat header. */
export function PrBadge({ prs, compact = false }: { prs: PrInfo[]; compact?: boolean }) {
  if (!prs.length) return null;
  const { open, merged, closed, ready } = prSummary(prs);
  if (compact) {
    const label = `${merged} merged, ${open} open, ${closed} closed PRs`;
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[10px] tabular-nums text-ink-faint" aria-label={label} title={label}>
        <BranchIcon className="h-3 w-3" />
        {merged > 0 && <span className="inline-flex items-center gap-0.5" style={{ color: 'var(--success)' }}>{merged}<CheckIcon className="h-3 w-3" /></span>}
        {open > 0 && <span className="inline-flex items-center gap-0.5" style={{ color: 'var(--warning)' }}>{open}<svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>}
        {closed > 0 && <span className="inline-flex items-center gap-0.5">{closed}<CloseIcon className="h-3 w-3" /></span>}
      </span>
    );
  }
  const chips: React.ReactNode[] = [];
  if (open > 0) {
    chips.push(
      <span
        key="open"
        className="shrink-0 rounded-sm px-1 py-px text-[9px] font-medium leading-normal"
        style={ready ? { background: 'rgba(46,160,67,0.18)', color: '#3fb950' } : { background: 'var(--accent-soft)', color: 'var(--accent)' }}
        title={ready ? 'PR ready to merge' : `${open} open PR${open === 1 ? '' : 's'}`}
      >
        {ready ? 'PR ready' : `⑂ ${open}`}
      </span>,
    );
  }
  if (merged > 0 && (!compact || open === 0)) {
    chips.push(
      <span key="merged" className="shrink-0 rounded-sm px-1 py-px text-[9px] font-medium leading-normal" style={{ background: 'rgba(147,51,234,0.18)', color: '#c084fc' }} title={`${merged} merged PR${merged === 1 ? '' : 's'}`}>
        ✓ {merged}
      </span>,
    );
  }
  if (!chips.length) return null;
  return <span className="flex shrink-0 items-center gap-1">{compact ? chips.slice(0, 1) : chips}</span>;
}
