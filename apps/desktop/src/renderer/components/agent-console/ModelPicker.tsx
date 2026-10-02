import React, { useEffect, useRef, useState } from 'react';
import type { AutoQuality, ModelInfo, ProviderConfig } from '@agent-nekko/shared';
import {
  AUTO_MODEL_ID, AUTO_QUALITIES, AUTO_QUALITY_META, blockLabel, formatModelPriceLabel,
  isLocalProvider, modelPricing, resolveModelAvailability,
} from '@agent-nekko/shared';
import { useStore } from '../../store.js';
import { useAllProviderLimits } from '../../useLimits.js';
import { StarIcon } from '../../icons.js';

/**
 * Provider + model as one legible control (instead of two microscopic selects):
 * a chip naming the current model that opens a flat picker of every provider's
 * models, grouped by provider, starred on top, Auto first.
 */
export function ModelPicker({
  providers,
  providerId,
  models,
  modelId,
  open,
  onOpenChange,
  needsChoice,
  hint,
  onProvider,
  onModel,
  expanded = false,
  recent = [],
}: {
  providers: ProviderConfig[];
  providerId: string | null;
  models: ModelInfo[];
  modelId: string | null;
  /** Open state is owned by the pane so the "choose a model" nudges can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** No model picked yet: the chip asks for one instead of reading as a setting. */
  needsChoice?: boolean;
  /** One-shot nudge shown over the chip; the pane retires it once the menu opens. */
  hint?: string | null;
  onProvider: (id: string) => void;
  onModel: (providerId: string, id: string) => void;
  /** Render the list inline in an empty conversation instead of in a popover. */
  expanded?: boolean;
  recent?: string[];
}) {
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const setOpen = (next: boolean) => onOpenChange(next);
  const [query, setQuery] = useState('');
  // Models per provider, fetched when the menu opens so the list covers every
  // provider (the `models` prop only holds the active provider's).
  const [byProvider, setByProvider] = useState<Record<string, ModelInfo[]>>({});
  // Live usage limits for every signed-in provider, so a model that can't run
  // right now can say so instead of quietly failing on send.
  const limitsByToken = useAllProviderLimits(providers, open);
  const ref = useRef<HTMLDivElement>(null);
  const hintId = React.useId();

  useEffect(() => {
    if (!open || expanded) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, expanded]);

  useEffect(() => {
    if (!open && !expanded) return;
    let live = true;
    Promise.all(
      providers.map((p) =>
        window.nekko.listModels(p.id)
          .then((m) => [p.id, m] as const)
          .catch(() => [p.id, [] as ModelInfo[]] as const),
      ),
    ).then((entries) => { if (live) setByProvider(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [open, expanded, providers]);

  const favSet = new Set(settings?.favoriteModels ?? []);
  const toggleFavorite = async (key: string) => {
    const next = new Set(settings?.favoriteModels ?? []);
    next.has(key) ? next.delete(key) : next.add(key);
    await window.nekko.updateSettings({ favoriteModels: [...next] });
    refreshSettings();
  };

  const modelsOf = (pid: string): ModelInfo[] =>
    byProvider[pid] ?? (pid === providerId ? models : []);
  const q = query.trim().toLowerCase();
  const matches = (m: ModelInfo) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);

  const groups = providers
    .map((p) => ({ provider: p, models: modelsOf(p.id).filter(matches) }))
    .filter((g) => g.models.length > 0);
  const starred = groups.flatMap((g) =>
    g.models
      .filter((m) => favSet.has(`${g.provider.id}::${m.id}`) && !recent.includes(`${g.provider.id}::${m.id}`))
      .map((m) => ({ provider: g.provider, model: m })),
  );
  const recentModels = recent.map((key) => {
    const group = groups.find((g) => key.startsWith(`${g.provider.id}::`));
    const model = group?.models.find((m) => key === `${group.provider.id}::${m.id}`);
    return group && model ? { provider: group.provider, model } : null;
  }).filter((entry): entry is { provider: ProviderConfig; model: ModelInfo } => !!entry).slice(0, 5);
  const total = providers.reduce((n, p) => n + modelsOf(p.id).length, 0);
  const pinnedKeys = new Set([...recentModels, ...starred].map((s) => `${s.provider.id}::${s.model.id}`));

  const providerLabel = providers.find((p) => p.id === providerId)?.label ?? 'No provider';
  const currentName =
    modelId === AUTO_MODEL_ID ? '✨ Auto' : models.find((m) => m.id === modelId)?.name ?? 'No model';

  const pick = (pid: string, mid: string) => {
    if (pid !== providerId) onProvider(pid);
    onModel(pid, mid);
    if (!expanded) setOpen(false);
  };

  /**
   * Why a model can't be run, or null when it can. Provider-agnostic: the
   * catalog's own claim (a model gated behind a bigger plan) combined with the
   * live usage windows for whichever account this provider signs in as.
   */
  const availabilityOf = (p: ProviderConfig, m: ModelInfo) =>
    resolveModelAvailability({ model: m, provider: p, limits: p.tokenKey ? limitsByToken[p.tokenKey] : undefined });

  const row = (p: ProviderConfig, m: ModelInfo, showProvider: boolean) => {
    const key = `${p.id}::${m.id}`;
    const fav = favSet.has(key);
    const selected = p.id === providerId && modelId === m.id;
    const price = formatModelPriceLabel({ modelId: m.id, auth: p.auth, isLocal: isLocalProvider(p.kind), pricing: modelPricing(m) });
    // A blocked model stays in the list and says why. Hiding it makes a model
    // that exists look like one the app never heard of.
    const availability = availabilityOf(p, m);
    const blocked = availability.status === 'blocked';
    const why = availability.detail ?? blockLabel(availability);
    // The engine sends the file's path as a detail, so a local model's subtext
    // is where it lives rather than a price it does not have.
    const sub = m.details?.path;
    return (
      <div
        key={key}
        className={`flex w-full items-center rounded-lg hover:bg-surface-2 ${selected ? 'text-accent' : ''}`}
      >
        <button
          role="option"
          aria-selected={selected}
          aria-disabled={blocked}
          disabled={blocked}
          className={`flex min-w-0 flex-1 flex-col px-2.5 py-1.5 text-left ${blocked ? 'cursor-not-allowed' : ''}`}
          onClick={() => pick(p.id, m.id)}
          title={blocked ? `${m.name} · ${why}` : sub ? `${m.name} · ${sub}` : m.name}
        >
          <div className="flex w-full items-center gap-2">
            {m.loaded && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--success)' }}
                title="Loaded in memory"
              />
            )}
            <span className={`min-w-0 truncate text-[12.5px] font-medium leading-tight ${blocked ? 'text-ink-faint' : ''}`}>{m.name}</span>
            {blocked && (
              <span
                className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] font-semibold leading-none"
                style={{
                  background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
                  color: 'var(--danger)',
                }}
              >
                {blockLabel(availability)}
              </span>
            )}
            {showProvider && <span className="ml-auto shrink-0 text-[10px] text-ink-faint">{p.label}</span>}
          </div>
          <span
            className={`truncate text-[10px] text-ink-faint ${sub ? 'font-mono' : ''}`}
            title={blocked ? why : sub ?? 'Estimated list price per 1M tokens'}
          >
            {blocked ? why : sub ?? price}
          </span>
        </button>
        <button
          className={`shrink-0 rounded-sm p-1.5 ${fav ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
          title={fav ? 'Unstar' : 'Star (pin to the top of this list)'}
          aria-label={fav ? `Unstar ${m.name}` : `Star ${m.name}`}
          aria-pressed={fav}
          onClick={() => toggleFavorite(key)}
        >
          <StarIcon className="h-3.5 w-3.5" filled={fav} />
        </button>
      </div>
    );
  };

  const header = (label: string) => (
    <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
  );

  return (
    <div ref={ref} className={expanded ? 'h-full min-h-0 w-full min-w-0' : 'relative min-w-0 max-w-[240px]'}>
      {/* The nudge rides above the chip as a tooltip rather than a strip in the
          composer: it says its piece without pushing the composer down, and the
          menu it asks for opens into the same space, replacing it. */}
      {hint && !open && (
        <div
          id={hintId}
          role="tooltip"
          className="fade-in pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-max max-w-[260px] rounded-xl border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
            background: 'var(--surface)',
          }}
        >
          <span className="font-medium text-accent">Choose a model</span>
          <span className="text-ink-soft"> · {hint}</span>
          <span
            className="absolute bottom-[-5px] left-4 h-2 w-2 rotate-45 border-b border-r"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
              background: 'var(--surface)',
            }}
          />
        </div>
      )}
      {!expanded && <button
        className="ctl-menu max-w-full"
        style={needsChoice ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-describedby={hint && !open ? hintId : undefined}
        title={needsChoice ? 'This chat has no model yet - pick one' : `Model: ${currentName} · ${providerLabel}`}
      >
        <span className="min-w-0 truncate">{needsChoice ? 'Choose a model' : currentName}</span>
        <span className="ctl-menu-label hidden min-w-0 truncate md:inline">· {providerLabel}</span>
        <span className="ctl-caret">▾</span>
      </button>}
      {/* The menu opens rightwards from the chip's own left edge: the picker is
          the leftmost control of its row and the menu is wider than the chip, so
          anchoring it right hung it outside the pane, over the sidebar. */}
      {(open || expanded) && (
        <div className={expanded ? 'card flex h-full min-h-0 w-full flex-col p-2 text-left' : 'card absolute bottom-full left-0 z-40 mb-2 flex max-h-96 w-[26rem] max-w-[calc(100vw-2rem)] flex-col p-1.5 shadow-lg'}>
          {/* Wide enough for a local model's path to read under its name; still
              capped so it never runs off a narrow pane. */}
          {(expanded || total > 8) && (
            <input
              className="input mb-1 rounded-lg px-2.5 py-1 text-[12px]"
              placeholder="Filter models…"
              value={query}
              autoFocus={!expanded}
              aria-label="Filter models"
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Model">
            {providers.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">No provider configured.</p>}
            {providers.length > 0 && groups.length === 0 && (
              <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">{q ? 'No models match.' : 'No models available.'}</p>
            )}
            {total > 1 && !q && (
              <button
                role="option"
                aria-selected={modelId === AUTO_MODEL_ID}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2 ${modelId === AUTO_MODEL_ID ? 'text-accent' : ''}`}
                onClick={() => { onModel(providerId ?? '', AUTO_MODEL_ID); setOpen(false); }}
                title="Agent Nekko picks the best model for each message"
              >
                ✨ Auto <span className="text-[11px] text-ink-faint">(pick best)</span>
              </button>
            )}
            {recentModels.length > 0 && !q && <>{header('Recent')}{recentModels.map((s) => row(s.provider, s.model, true))}</>}
            {starred.length > 0 && !q && (
              <>
                {header('★ Starred')}
                {starred.map((s) => row(s.provider, s.model, true))}
              </>
            )}
            {groups.map((g) => {
              const remaining = q ? g.models : g.models.filter((m) => !pinnedKeys.has(`${g.provider.id}::${m.id}`));
              if (!remaining.length) return null;
              // A local provider can serve models out of several folders; when
              // the rows say where they live, group them under that heading.
              const locs = [...new Set(remaining.map((m) => m.details?.location ?? ''))];
              const byLoc =
                locs.length > 1
                  ? locs.map((loc) => ({ loc, models: remaining.filter((m) => (m.details?.location ?? '') === loc) }))
                  : [{ loc: '', models: remaining }];
              return (
                <React.Fragment key={g.provider.id}>
                  {header(g.provider.label)}
                  {byLoc.map(({ loc, models: ms }) => (
                    <React.Fragment key={loc || '_'}>
                      {loc && (
                        <p className="truncate px-4 pb-0.5 pt-1 text-[10px] italic text-ink-faint" title={loc}>
                          {loc}
                        </p>
                      )}
                      {ms.map((m) => row(g.provider, m, false))}
                    </React.Fragment>
                  ))}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * How hard ✨ Auto leans on capability for this chat. Sits beside the model chip
 * and only while Auto is selected, so the strip doesn't carry a control that
 * does nothing.
 */
export function AutoQualityMenu({
  quality,
  onPick,
  followCapacity,
  onFollowCapacity,
}: {
  quality: AutoQuality;
  onPick: (q: AutoQuality) => void;
  /** Whether Auto may move a turn to an equivalent model elsewhere. */
  followCapacity?: boolean;
  onFollowCapacity?: (v: boolean) => void;
}) {
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

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="ctl-menu whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Auto profile: ${AUTO_QUALITY_META[quality].label} - ${AUTO_QUALITY_META[quality].description}`}
      >
        <span className="ctl-menu-label">Auto</span>
        {AUTO_QUALITY_META[quality].label}
        <span className="ctl-caret">▾</span>
      </button>
      {open && (
        <div className="card absolute bottom-8 left-0 z-40 w-60 p-1.5 shadow-lg" role="menu">
          {AUTO_QUALITIES.map((q) => (
            <button
              key={q}
              role="menuitemradio"
              aria-checked={quality === q}
              className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${quality === q ? 'text-accent' : ''}`}
              onClick={() => { onPick(q); setOpen(false); }}
            >
              <span className="text-[13px] font-medium">{AUTO_QUALITY_META[q].label}</span>
              <span className="text-[11px] text-ink-faint">{AUTO_QUALITY_META[q].description}</span>
            </button>
          ))}
          {onFollowCapacity && (
            <button
              role="menuitemcheckbox"
              aria-checked={!!followCapacity}
              className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
              onClick={() => onFollowCapacity(!followCapacity)}
            >
              <span
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] ${followCapacity ? 'border-accent bg-accent text-white' : 'border-line'}`}
                aria-hidden
              >
                {followCapacity ? '✓' : ''}
              </span>
              <span>
                <span className="block text-[13px] font-medium">Follow capacity &amp; cost</span>
                <span className="block text-[11px] leading-snug text-ink-faint">
                  When this provider is spent or an equivalent model elsewhere is much cheaper, run the turn there and say why. Never a downgrade.
                </span>
              </span>
            </button>
          )}
          <p className="border-t border-line px-2.5 pb-0.5 pt-1.5 text-[10px] text-ink-faint">Applies to this chat only.</p>
        </div>
      )}
    </div>
  );
}
