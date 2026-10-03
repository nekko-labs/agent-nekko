import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GitStatus, Session } from '@agent-nekko/shared';
import { WorktreeIcon, CheckIcon } from '../icons.js';
import { useStore } from '../store.js';

/** Checkout context stays beside the checkout, rather than in the transcript. */
export function WorktreeChip({ session, git, disabled, onChange }: {
  session: Session; git: GitStatus; disabled: boolean; onChange: (session: Session) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 8, top: 8 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isolated = session.gitIsolation !== false && !!git.worktree;
  const enter = () => { clearTimeout(timer.current); setOpen(true); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 180); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)), top: rect.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); anchor.current?.focus(); } };
    const away = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', key);
    document.addEventListener('mousedown', away);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', away); };
  }, [open]);
  const switchMode = async (gitIsolation: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.nekko.setSessionOptions(session.id, { gitIsolation });
      if (!next) throw new Error('Chat no longer exists.');
      onChange(next);
      const settings = useStore.getState().settings;
      await window.nekko.updateSettings({ gitManagement: { ...settings?.gitManagement, mode: gitIsolation ? 'worktree' : 'shared' } });
      await useStore.getState().refreshSettings();
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  const notices = [...new Set(Object.values(session.gitWorktrees ?? {}).map((w) => w.notice))];
  return <>
    <button ref={anchor} type="button" aria-label="Git checkout options" aria-haspopup="dialog" aria-expanded={open}
      className="inline-flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-px"
      style={{ background: 'color-mix(in srgb, var(--accent-2) 13%, transparent)', color: 'var(--accent-2)' }}
      onMouseEnter={enter} onMouseLeave={leave} onFocus={enter} onBlur={leave} onClick={enter}>
      <WorktreeIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">{isolated ? git.worktree?.name : 'Current branch'}</span>
    </button>
    {open && createPortal(<div ref={panel} role="dialog" aria-label="Git checkout options"
      className="fixed z-50 max-w-[calc(100vw-16px)] w-[340px] rounded-lg border border-line bg-paper p-3 text-[12px] shadow-lg"
      style={pos} onMouseEnter={enter} onMouseLeave={leave} onFocus={enter}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) leave(); }}>
      <p className="font-medium text-ink">Git checkout</p>
      <div className="mt-2 space-y-2 text-ink-soft">
        {isolated ? (notices.length ? notices : ['This chat uses an isolated Git worktree from committed HEAD.']).map((notice) =>
          <p key={notice}>{notice.replace(/ Interrupt if you want[\s\S]*?(?= Copied from|$)/, '')}</p>)
          : <p>This chat uses the project’s current Git branch, including local changes. Other chats using this checkout share its files.</p>}
      </div>
      {git.worktree && isolated && <p className="mt-2 break-all text-[11px] text-ink-faint">{git.worktree.path}</p>}
      <div className="mt-3 space-y-1">
        {[{ value: true, label: 'Use worktrees' }, { value: false, label: 'Use current Git branch' }].map(({ value, label }) =>
          <button key={label} type="button" disabled={disabled || busy} aria-pressed={(session.gitIsolation !== false) === value}
            className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-ink hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-40"
            onClick={() => void switchMode(value)}>
            {label}{(session.gitIsolation !== false) === value && <CheckIcon className="h-3 w-3" />}
          </button>)}
      </div>
      <p className="mt-2 text-[11px] text-ink-faint">Applies to this chat and new chats. Existing worktrees are kept; edits and commits are not moved between checkouts.</p>
      {disabled && <p className="mt-2 text-[11px] text-ink-faint">Stop the current run before switching.</p>}
      {error && <p role="alert" className="mt-2 text-[11px] text-danger">{error}</p>}
    </div>, document.body)}
  </>;
}
