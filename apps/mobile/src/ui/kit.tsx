/** Small shared building blocks: text, buttons, cards, pills. */
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './Icon';
import { radius, space, type, usePalette } from './theme';

type Tone = 'ink' | 'soft' | 'faint' | 'accent' | 'danger' | 'success' | 'warning';

export function T({
  children,
  variant = 'body',
  tone = 'ink',
  style,
  numberOfLines,
  selectable,
}: {
  children: ReactNode;
  variant?: keyof typeof type;
  tone?: Tone;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const p = usePalette();
  const color = { ink: p.ink, soft: p.inkSoft, faint: p.inkFaint, accent: p.accent, danger: p.danger, success: p.success, warning: p.warning }[tone];
  return (
    <Text style={[type[variant], { color }, style]} numberOfLines={numberOfLines} selectable={selectable}>
      {children}
    </Text>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  icon,
  busy,
  disabled,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: IconName;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const p = usePalette();
  const bg = { primary: p.accent, secondary: p.surface2, ghost: 'transparent', danger: p.dangerSoft }[kind];
  const fg = { primary: p.accentInk, secondary: p.ink, ghost: p.accent, danger: p.danger }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: off ? 0.5 : pressed ? 0.8 : 1 }, style]}>
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={17} color={fg} /> : null}
      <Text style={[type.small, { color: fg, fontWeight: '600' }]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const p = usePalette();
  return <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.line }, style]}>{children}</View>;
}

export function Pill({ label, tone = 'soft', icon }: { label: string; tone?: 'soft' | 'accent' | 'success' | 'warning' | 'danger'; icon?: IconName }) {
  const p = usePalette();
  const map = {
    soft: [p.surface2, p.inkSoft],
    accent: [p.accentSoft, p.accent],
    success: [p.successSoft, p.success],
    warning: [p.warningSoft, p.warning],
    danger: [p.dangerSoft, p.danger],
  } as const;
  const [bg, fg] = map[tone];
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      {icon ? <Icon name={icon} size={11} color={fg} /> : null}
      <Text style={[type.caption, { color: fg, fontWeight: '600' }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** Connection dot: green online, amber connecting/offline, red denied. */
export function Dot({ tone }: { tone: 'success' | 'warning' | 'danger' | 'faint' }) {
  const p = usePalette();
  const color = { success: p.success, warning: p.warning, danger: p.danger, faint: p.inkFaint }[tone];
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.section}>
      <T variant="caption" tone="faint" style={{ textTransform: 'uppercase', letterSpacing: 0.8, fontWeight: '600' }}>
        {title}
      </T>
      {action}
    </View>
  );
}

export function ProgressBar({ value, color }: { value: number | null; color?: string }) {
  const p = usePalette();
  return (
    <View style={[styles.track, { backgroundColor: p.surface2 }]}>
      <View style={{ width: `${Math.round(Math.max(0.02, Math.min(1, value ?? 0.3)) * 100)}%`, height: '100%', backgroundColor: color ?? p.accent, borderRadius: 3 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.lg },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.sm },
  track: { height: 6, borderRadius: 3, overflow: 'hidden', width: '100%' },
});
