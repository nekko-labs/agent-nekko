import React from 'react';
import type { AppSettings, ThemePreset } from '@agent-nekko/shared';
import { THEME_PRESETS } from '@agent-nekko/shared';
import { useT } from '../i18n.js';

/**
 * Gradient-swatch preset grid shared by Settings → Appearance and the
 * onboarding theme step. Selecting a preset writes theme + themePreset +
 * accent + accent2 in one patch; the caller's `update` persists and applies it,
 * so a click previews live.
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

  const select = (preset: ThemePreset) => {
    void update({
      theme: preset.mode,
      themePreset: preset.id,
      accent: preset.accent,
      accent2: preset.accent2,
    });
  };

  return (
    <div className={showLabel ? 'mt-4' : undefined}>
      {showLabel && <span className="text-[13px]">{tr('settings.theme')}</span>}
      <div
        className={`${showLabel ? 'mt-2' : ''} grid grid-cols-4 gap-2`}
        role="radiogroup"
        aria-label={tr('settings.theme')}
      >
        {THEME_PRESETS.map((preset) => {
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
}
