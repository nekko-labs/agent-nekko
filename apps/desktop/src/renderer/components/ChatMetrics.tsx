import React, { useEffect, useRef, useState } from 'react';
import type { ContextBundle, ContextItem, EffortLevel } from '@agent-nekko/shared';
import { effectiveEffort, modelDefaultEffort, modelEffortLevels, usesNativeEffort } from '@agent-nekko/shared';
import { formatUSD } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { sourceMeta } from '../contextSources.js';

const FREE_COLOR = 'var(--surface-2)';

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

/**
 * `n.toLocaleString()`, with the formatter built once. The gauge repaints as a
 * reply streams, and toLocaleString() constructs a new formatter on every call.
 */
let numberFormat: Intl.NumberFormat | undefined;
const num = (n: number) => (numberFormat ??= new Intl.NumberFormat()).format(n);

/**
 * Compact context-window gauge for the composer footer: usage bar + count with
 * a hover/focus breakdown of where the tokens go (mirrors the Context
 * Inspector's color vocabulary), plus the chat's estimated cost. Keyboard
 * users reach the breakdown by focusing the gauge.
 */
export function ContextGauge({
  bundle,
  cost,
  subscription,
  skill,
  draftTokens = 0,
  liveTokens = 0,
  contextWindow,
}: {
  bundle: ContextBundle | null;
  cost?: number;
  /** True when the chat runs on a subscription provider, so cost is $0. */
  subscription?: boolean;
  /** The skill armed in the composer, folded into the token count when present. */
  skill?: { name: string; tokens: number } | null;
  /** Tokens of the unsent draft, so the gauge tracks what you're typing. */
  draftTokens?: number;
  /**
   * Tokens the running turn has produced since the bundle was built. The agent's
   * own replies and tool traffic are replayed in the next request, so they are
   * window usage the moment they exist, not once the turn ends.
   */
  liveTokens?: number;
  /**
   * The picked model's real window, which beats the bundle's id-based guess and
   * updates the instant the model changes rather than on the next reply.
   */
  contextWindow?: number;
}) {
  const included = (bundle?.items ?? []).filter((i: ContextItem) => i.included);
  const used = included.reduce((s, i) => s + i.tokens, 0) + (skill?.tokens ?? 0) + draftTokens + liveTokens;
  const windowTokens = contextWindow ?? bundle?.contextWindow ?? 0;
  const pct = windowTokens ? Math.min(100, (used / windowTokens) * 100) : 0;

  const bySource = included.reduce<Record<string, number>>((acc, i) => {
    acc[i.source] = (acc[i.source] ?? 0) + i.tokens;
    return acc;
  }, {});
  if (skill?.tokens) bySource.skill = (bySource.skill ?? 0) + skill.tokens;
  if (draftTokens) bySource.draft = (bySource.draft ?? 0) + draftTokens;
  if (liveTokens) bySource.reply = (bySource.reply ?? 0) + liveTokens;

  // Rows for the breakdown, biggest first, each with its share of the window.
  const rows = Object.entries(bySource)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([src, n]) => ({
      src,
      n,
      meta: sourceMeta(src),
      pctWin: windowTokens ? (n / windowTokens) * 100 : 0,
    }));
  const free = windowTokens ? Math.max(0, windowTokens - used) : 0;
  const freePct = windowTokens ? (free / windowTokens) * 100 : 0;

  return (
    <div className="group relative flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
      <span
        className="flex cursor-default items-center gap-1.5 rounded-md px-1 py-0.5 outline-hidden focus-visible:ring-2 focus-visible:ring-(--ring)"
        tabIndex={0}
        aria-label={`Context: ${num(used)}${windowTokens ? ` of ${num(windowTokens)}` : ''} tokens in use`}
      >
        <span className="font-medium text-ink-soft">Context</span>
        <span className="tabular-nums">
          {fmt(used)}{windowTokens ? ` / ${fmt(windowTokens)}` : ''}
        </span>
        <span className="h-1.5 w-14 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
          <span
            className="block h-full rounded-full transition-[width] duration-300"
            style={{ width: `${pct}%`, background: pct > 85 ? 'var(--danger)' : 'var(--accent)' }}
          />
        </span>
      </span>
      {cost != null && cost > 0 ? (
        <span className="hidden sm:inline" title="Estimated cost of this chat (list prices; local models are free)">
          · {formatUSD(cost)}
        </span>
      ) : subscription ? (
        <span
          className="hidden sm:inline"
          title="Runs on a subscription plan; no per-token API cost."
          aria-label="Runs on a subscription plan; no per-token API cost."
        >
          · Subscription
        </span>
      ) : null}
      {/* Expanded breakdown: segmented bar + per-source rows with %, plus free space. */}
      <div
        className="pointer-events-none absolute bottom-7 left-0 z-40 hidden w-72 rounded-xl border border-line p-3 text-[11px] shadow-lg group-hover:block group-focus-within:block"
        style={{ background: 'var(--surface)' }}
        role="tooltip"
      >
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-semibold text-ink">Context window</span>
          <span className="text-ink-faint">
            {windowTokens ? `${num(used)} / ${num(windowTokens)}` : num(used)}
            {windowTokens ? <span className="ml-1 text-ink-soft">({Math.round(pct)}%)</span> : null}
          </span>
        </div>
        {/* Segmented usage bar */}
        {windowTokens > 0 && (
          <div className="mb-2.5 flex h-2 w-full overflow-hidden rounded-full" style={{ background: FREE_COLOR }}>
            {rows.map((r) => (
              <span key={r.src} title={`${r.meta.label}: ${num(r.n)} tok`} style={{ width: `${r.pctWin}%`, background: r.meta.color }} />
            ))}
          </div>
        )}
        {included.length === 0 && !skill?.tokens && <div className="text-ink-faint">Nothing in context yet.</div>}
        {rows.map((r) => (
          <div key={r.src} className="flex items-center gap-2 py-0.5">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.meta.color }} />
            <span className="min-w-0 flex-1 truncate text-ink-soft">{r.meta.label}</span>
            <span className="shrink-0 tabular-nums text-ink-faint">{num(r.n)} tok</span>
            {windowTokens > 0 && <span className="w-9 shrink-0 text-right tabular-nums text-ink-faint">{r.pctWin < 0.1 ? '<0.1' : r.pctWin.toFixed(1)}%</span>}
          </div>
        ))}
        {windowTokens > 0 && (
          <div className="flex items-center gap-2 py-0.5">
            <span className="h-2 w-2 shrink-0 rounded-full border border-line" style={{ background: FREE_COLOR }} />
            <span className="min-w-0 flex-1 truncate text-ink-soft">Free space</span>
            <span className="shrink-0 tabular-nums text-ink-faint">{num(free)} tok</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-ink-faint">{freePct.toFixed(1)}%</span>
          </div>
        )}
        <div className="mt-1.5 flex justify-between border-t border-line pt-1.5 font-medium text-ink">
          <span>Total in use</span>
          <span className="tabular-nums">{num(used)} tok</span>
        </div>
      </div>
    </div>
  );
}

const EFFORT_DESC: Record<EffortLevel, string> = {
  low: 'Quick answers, lighter reasoning.',
  medium: 'Lighter than the usual default, still careful.',
  normal: 'The balanced default.',
  high: 'Thorough. The default on most Claude models.',
  xhigh: 'Deeper still. Best for most coding and agent work.',
  max: 'Everything it has. Slowest and most tokens.',
};

const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  normal: 'Normal',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

/**
 * Effort as an explicit menu (not a blind cycle), offering the rungs the chat's
 * model actually has: Anthropic's five on Claude models that take an effort
 * level, the three temperature steps everywhere else. "Default" sends the
 * model's own default and names the rung it resolves to, because that rung is
 * not the same on every model (Opus 5.5 defaults to medium, Opus 5 to high).
 * The setting itself is still global, which the menu says.
 */
export function EffortMenu({ modelId }: { modelId?: string }) {
  const settings = useStore((s) => s.settings);
  const saved = settings?.effort ?? 'normal';
  const levels = modelEffortLevels(modelId);
  const native = usesNativeEffort(modelId);
  const fallback = modelDefaultEffort(modelId);
  // What this model will actually be sent, which is what the button shows: a
  // saved `xhigh` on a temperature model runs as `high`, and says so.
  const effective = effectiveEffort(saved, modelId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const pick = (level: EffortLevel) => {
    window.nekko.updateSettings({ effort: level });
    useStore.getState().refreshSettings();
    setOpen(false);
  };

  // On Claude, "Default" is its own row that follows the model; on the
  // temperature scale `normal` already is the default and sits in the middle.
  const rows: Array<{ level: EffortLevel; label: string; desc: string }> = [
    ...(native
      ? [{ level: 'normal' as const, label: `Default (${EFFORT_LABEL[fallback].toLowerCase()})`, desc: "Whatever this model runs at when you don't choose." }]
      : []),
    ...levels.map((level) => ({ level, label: EFFORT_LABEL[level], desc: EFFORT_DESC[level] })),
  ];
  const checked = (level: EffortLevel) => (native && saved === 'normal' ? level === 'normal' : level === effective);
  const shown = native && saved === 'normal' ? `Default · ${EFFORT_LABEL[fallback]}` : EFFORT_LABEL[effective];

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="ctl-menu whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          effective !== saved && !(native && saved === 'normal')
            ? `Saved as ${EFFORT_LABEL[saved]}, which this model runs as ${EFFORT_LABEL[effective]} (applies to all chats)`
            : 'How much reasoning effort the model spends per reply (applies to all chats)'
        }
      >
        <span className="ctl-menu-label">Effort</span>
        <span>{shown}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {open && (
        <div className="card absolute bottom-8 right-0 z-40 w-60 p-1.5 shadow-lg" role="menu">
          {rows.map((row) => (
            <button
              key={row.level}
              role="menuitemradio"
              aria-checked={checked(row.level)}
              className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${checked(row.level) ? 'text-accent' : ''}`}
              onClick={() => pick(row.level)}
            >
              <span className="text-[13px] font-medium">{row.label}</span>
              <span className="text-[11px] text-ink-faint">{row.desc}</span>
            </button>
          ))}
          <p className="border-t border-line px-2.5 pb-0.5 pt-1.5 text-[10px] text-ink-faint">
            {native ? 'Levels this model offers. ' : 'This model is steered by temperature. '}Applies to all chats.
          </p>
        </div>
      )}
    </div>
  );
}
