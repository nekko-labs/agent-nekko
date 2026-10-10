/**
 * Agent Nekko's palette, carried over from the desktop's `styles.css` tokens
 * (paper / surface / ink / accent and the status hues) so the phone reads as
 * the same product. Dark is the default look, matching the desktop.
 */
import { useColorScheme } from 'react-native';

const light = {
  paper: '#fbfbfd',
  surface: '#ffffff',
  surface2: '#f2f2f7',
  line: '#e8e8ef',
  ink: '#17171d',
  inkSoft: '#52525e',
  inkFaint: '#8a8a97',
  accent: '#6d5efc',
  accentInk: '#ffffff',
  accentSoft: 'rgba(109, 94, 252, 0.13)',
  accent2: '#06b6d4',
  success: '#3aa870',
  successSoft: 'rgba(58, 168, 112, 0.14)',
  danger: '#d24738',
  dangerSoft: 'rgba(210, 71, 56, 0.14)',
  warning: '#c9871f',
  warningSoft: 'rgba(201, 135, 31, 0.14)',
  running: '#3b82f6',
  userBubble: '#6d5efc',
  userInk: '#ffffff',
  code: '#f2f2f7',
};

const dark: typeof light = {
  paper: '#0c0c11',
  surface: '#16161c',
  surface2: '#20202a',
  line: '#26262f',
  ink: '#eceaf3',
  inkSoft: '#a3a1b0',
  inkFaint: '#6b6b78',
  accent: '#8b7dff',
  accentInk: '#0c0c11',
  accentSoft: 'rgba(139, 125, 255, 0.18)',
  accent2: '#22d3ee',
  success: '#4cc38a',
  successSoft: 'rgba(76, 195, 138, 0.16)',
  danger: '#ef6a5b',
  dangerSoft: 'rgba(239, 106, 91, 0.16)',
  warning: '#e3a446',
  warningSoft: 'rgba(227, 164, 70, 0.16)',
  running: '#60a5fa',
  userBubble: '#2a2550',
  userInk: '#eceaf3',
  code: '#101016',
};

export type Palette = typeof light;

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;
export const type = {
  title: { fontSize: 28, fontWeight: '700' as const, letterSpacing: -0.4 },
  heading: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 23 },
  small: { fontSize: 14, lineHeight: 19 },
  caption: { fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: 'monospace', fontSize: 13, lineHeight: 18 },
};
