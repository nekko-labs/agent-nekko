import type { ThemeMode } from './settings.js';

/**
 * A named theme preset. Presets combine a light/dark/system mode with a paired
 * accent + secondary accent and a small palette of swatch colors used to draw
 * the gradient circle in the theme picker.
 *
 * Some presets also carry surface/ink overrides for when the accent alone
 * cannot produce the intended atmosphere (e.g. a green-tinted terminal look or
 * a warm solar paper).
 */
export interface ThemePreset {
  /** Machine id used for `settings.themePreset` and `[data-preset]`. */
  id: string;
  /** Base mode the preset resolves to. */
  mode: ThemeMode;
  /** Primary accent color (6-digit hex). */
  accent: string;
  /** Secondary accent color used for the brand gradient (6-digit hex). */
  accent2: string;
  /** 3-4 key colors drawn as a conic gradient in the swatch circle. */
  swatch: string[];
  /** Human-readable label shown in the picker. */
  label: string;
  /** Optional tinted surface/ink tokens for presets that need deeper changes. */
  paper?: string;
  surface?: string;
  surface2?: string;
  ink?: string;
  inkSoft?: string;
  inkFaint?: string;
  line?: string;
}

/** v1 theme preset catalog. Names and palettes are intentionally adjustable. */
export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'system',
    mode: 'system',
    accent: '#6d5efc',
    accent2: '#06b6d4',
    swatch: ['#6d5efc', '#06b6d4', '#8b7dff', '#22d3ee'],
    label: 'System',
  },
  {
    id: 'light',
    mode: 'light',
    accent: '#6d5efc',
    accent2: '#06b6d4',
    swatch: ['#6d5efc', '#06b6d4', '#f2f2f7'],
    label: 'Light',
  },
  {
    id: 'dark',
    mode: 'dark',
    accent: '#8b7dff',
    accent2: '#22d3ee',
    swatch: ['#8b7dff', '#22d3ee', '#16161c'],
    label: 'Dark',
  },
  {
    id: 'nebula',
    mode: 'dark',
    accent: '#a78bfa',
    accent2: '#f472b6',
    swatch: ['#a78bfa', '#f472b6', '#140f26', '#2e1065'],
    label: 'Nebula',
    paper: '#0a0714',
    surface: '#140f26',
    surface2: '#1f1838',
    ink: '#ece7fb',
    inkSoft: '#a99cc9',
    inkFaint: '#6e6392',
    line: '#2b2148',
  },
  {
    id: 'terminal',
    mode: 'dark',
    accent: '#22c55e',
    accent2: '#84cc16',
    swatch: ['#22c55e', '#84cc16', '#0a100a'],
    label: 'Terminal',
    paper: '#070a07',
    surface: '#0e1a0e',
    surface2: '#162316',
    ink: '#e8f5e8',
    inkSoft: '#8bb08b',
    inkFaint: '#4e6b4e',
    line: '#1a261a',
  },
  {
    id: 'nord',
    mode: 'dark',
    accent: '#88c0d0',
    accent2: '#81a1c1',
    swatch: ['#88c0d0', '#81a1c1', '#2e3440'],
    label: 'Nord',
    paper: '#1e222a',
    surface: '#252a33',
    surface2: '#2e3440',
    ink: '#eceff4',
    inkSoft: '#9ca6b6',
    inkFaint: '#6b7787',
    line: '#3b4252',
  },
  {
    id: 'solar',
    mode: 'light',
    accent: '#b45309',
    accent2: '#d97706',
    swatch: ['#b45309', '#d97706', '#faf6ed'],
    label: 'Solar',
    paper: '#faf6ed',
    surface: '#fffdf6',
    surface2: '#f3ead9',
    ink: '#2b211a',
    inkSoft: '#6d5d4d',
    inkFaint: '#9e8d7a',
    line: '#e8dfc8',
  },
  {
    id: 'ember',
    mode: 'dark',
    accent: '#f97316',
    accent2: '#ef4444',
    swatch: ['#f97316', '#ef4444', '#1a120b'],
    label: 'Ember',
    paper: '#150f0b',
    surface: '#1c140e',
    surface2: '#261b14',
    ink: '#f7ece5',
    inkSoft: '#c7a998',
    inkFaint: '#8a6e5e',
    line: '#3d2a1f',
  },
];

/** Look up a preset by id. */
export function findThemePreset(id: string | undefined): ThemePreset | undefined {
  return THEME_PRESETS.find((p) => p.id === id);
}
