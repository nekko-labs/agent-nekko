import React, { useState } from 'react';
import type { AppSettings, ThemePreset } from '@agent-nekko/shared';
import { THEME_PRESETS, findThemePreset } from '@agent-nekko/shared';
import { useT } from '../i18n.js';
import { ColorWheel } from './ColorWheel.js';

/** Preset groups, so light and dark looks sit under their own headings. */
const GROUPS: Array<{ mode: ThemePreset['mode']; titleKey: string }> = [
  { mode: 'system', titleKey: 'settings.themeAuto' },
  { mode: 'light', titleKey: 'settings.themeLight' },
  { mode: 'dark', titleKey: 'settings.themeDark' },
];

/** The rainbow disc on the "Custom colors" tile. */
const WHEEL_SWATCH =
  'conic-gradient(from 0deg, #f87171, #fbbf24, #4ade80, #22d3ee, #818cf8, #e879f9, #f87171)';

/**
 * Grouped preset grid plus a color wheel, shared by Settings → Appearance and
 * the onboarding theme step. Selecting a preset writes theme + themePreset +
 * accent + accent2 in one patch; the caller's `update` persists and applies it,
 * so a click previews live.
 *
 * The wheel edits `accent`/`accent2` on top of whichever preset is selected:
 * the preset keeps owning the surface tokens, the wheel owns the brand colors.
 */
export function ThemePresetPicker({
  settings,
  update,
  showLabel = true,
  large = false,
}: {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  /** The "Theme" label the Settings row shows; the wizard supplies its own heading. */
  showLabel?: boolean;
  /** Roomier swatches for the onboarding step. */
  large?: boolean;
}) {
  const tr = useT();
  // Only highlight a preset when it was explicitly selected. Falling back to
  // `settings.theme` would falsely highlight a preset when the user only has a
  // base mode and a custom accent.
  const activeId = settings.themePreset;
  const activePreset = findThemePreset(activeId);
  const accent = settings.accent;
  // With no preset and no saved secondary, fall back to the base brand cyan the
  // stylesheet ships, so the gradient preview reads as a gradient and not a slab.
  const accent2 = settings.accent2 ?? activePreset?.accent2 ?? findThemePreset('system')?.accent2 ?? accent;
  // "Custom" means the colors no longer match what the selected preset ships.
  const customized =
    !!activePreset && (accent !== activePreset.accent || accent2 !== activePreset.accent2);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<'accent' | 'accent2'>('accent');

  const select = (preset: ThemePreset) => {
    void update({
      theme: preset.mode,
      themePreset: preset.id,
      accent: preset.accent,
      accent2: preset.accent2,
    });
  };

  const setColor = (hex: string) => void update(editing === 'accent' ? { accent: hex } : { accent2: hex });

  const resetColors = () => {
    if (!activePreset) return;
    void update({ accent: activePreset.accent, accent2: activePreset.accent2 });
  };

  return (
    <div className={showLabel ? 'mt-4' : undefined}>
      {showLabel && <span className="text-[13px]">{tr('settings.theme')}</span>}

      <div className={showLabel ? 'mt-2 space-y-3' : 'space-y-3'}>
        {GROUPS.map((group) => {
          const presets = THEME_PRESETS.filter((p) => p.mode === group.mode);
          if (presets.length === 0) return null;
          return (
            <div key={group.mode}>
              <span className="text-[11px] font-medium tracking-wide text-ink-faint uppercase">
                {tr(group.titleKey)}
              </span>
              <div className="mt-1.5 grid grid-cols-4 gap-2" role="radiogroup" aria-label={tr(group.titleKey)}>
                {presets.map((preset) => {
                  const active = activeId === preset.id;
                  const gradient = `conic-gradient(from 0deg, ${[...preset.swatch, preset.swatch[0]].join(', ')})`;
                  return (
                    <button
                      key={preset.id}
                      onClick={() => select(preset)}
                      title={preset.label}
                      role="radio"
                      aria-checked={active}
                      className={`flex flex-col items-center gap-1.5 rounded-xl border p-2 text-[11px] font-medium transition-colors ${
                        active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2'
                      }`}
                    >
                      <span
                        className={`${large ? 'h-14 w-14' : 'h-10 w-10'} rounded-full border border-line shadow-sm`}
                        style={{ background: gradient }}
                      />
                      <span className={active ? 'text-accent' : 'text-ink-soft'}>{preset.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Custom colors: the wheel rides on top of the selected preset. */}
      <div className="mt-3 rounded-xl border border-line bg-surface">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2.5 p-2.5 text-left"
        >
          <span
            className="h-8 w-8 shrink-0 rounded-full border border-line shadow-sm"
            style={{ background: WHEEL_SWATCH }}
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium">{tr('settings.customColors')}</span>
            <span className="block truncate text-[11px] text-ink-faint">
              {customized ? tr('settings.customColorsOn') : tr('settings.customColorsHint')}
            </span>
          </span>
          <span
            aria-hidden
            className="h-5 w-10 shrink-0 rounded-full border border-line"
            style={{ background: `linear-gradient(135deg, ${accent}, ${accent2})` }}
          />
          <span aria-hidden className="text-[11px] text-ink-faint">
            {open ? '▲' : '▼'}
          </span>
        </button>

        {open && (
          <div className="flex flex-wrap items-start gap-4 border-t border-line p-3">
            <ColorWheel
              value={editing === 'accent' ? accent : accent2}
              onChange={setColor}
              label={editing === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
            />
            <div className="min-w-[150px] flex-1 space-y-2">
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={tr('settings.customColors')}>
                {(['accent', 'accent2'] as const).map((which) => {
                  const on = editing === which;
                  return (
                    <button
                      key={which}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setEditing(which)}
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                        on ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2'
                      }`}
                    >
                      <span
                        className="h-4 w-4 shrink-0 rounded-full border border-line"
                        style={{ background: which === 'accent' ? accent : accent2 }}
                      />
                      <span className="truncate">
                        {which === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex items-center gap-2">
                <input
                  className="input py-1 font-mono text-[12px]"
                  aria-label={editing === 'accent' ? tr('settings.accent') : tr('settings.accent2')}
                  value={editing === 'accent' ? accent : accent2}
                  onChange={(e) => {
                    const next = e.target.value.trim();
                    // Let the field hold a half-typed hex; only commit a complete one.
                    if (/^#[0-9a-fA-F]{6}$/.test(next)) setColor(next.toLowerCase());
                  }}
                  spellCheck={false}
                />
                {/* The OS picker, for eyedroppers and exact values the wheel can't hit. */}
                <input
                  type="color"
                  className="h-7 w-9 shrink-0 rounded-lg"
                  aria-label={tr('settings.systemPicker')}
                  value={editing === 'accent' ? accent : accent2}
                  onChange={(e) => setColor(e.target.value)}
                />
              </div>
              <button
                className="text-[11px] text-accent hover:underline disabled:text-ink-faint disabled:no-underline"
                onClick={resetColors}
                disabled={!customized}
              >
                {tr('settings.resetColors')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
