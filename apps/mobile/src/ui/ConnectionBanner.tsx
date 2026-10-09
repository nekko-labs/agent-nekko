import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { relayHost } from '@/lib/pairing';
import { useStore } from '@/lib/store';
import { computers } from '@/services/computers';
import { Icon } from './Icon';
import { Dot, T } from './kit';
import { radius, space, usePalette } from './theme';

const DENIED_COPY: Record<string, string> = {
  revoked: 'This phone was removed on your computer. Pair it again.',
  'bad-code': 'That pairing code expired or was already used. Scan a fresh QR.',
  'unknown-device': 'Your computer doesn’t know this phone yet. Scan a pairing QR.',
  kicked: 'Your computer disconnected this phone. Pair it again.',
  'bad-key': 'The pairing key changed on your computer. Scan a fresh QR.',
  invalid: 'Pairing failed. Scan a fresh QR on your computer.',
};

/** One line saying whether your computer is reachable, and what to do if not. */
export function ConnectionBanner() {
  const p = usePalette();
  const s = useStore(computers, (x) => x);
  const active = s.computers.find((c) => c.id === s.activeId);
  if (!active) return null;

  let tone: 'success' | 'warning' | 'danger' = 'warning';
  let line = `Connecting to ${active.name}…`;
  if (s.denied) {
    tone = 'danger';
    line = DENIED_COPY[s.denied] ?? DENIED_COPY.invalid;
  } else if (s.conn === 'online') {
    tone = 'success';
    line = `${active.name} is online`;
  } else if (s.conn === 'offline') {
    line = `${active.name} is offline. Open Nekko Agent on it, or chat on this phone.`;
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => (s.denied ? router.push('/pair') : router.navigate('/computers'))}
      style={({ pressed }) => [styles.banner, { backgroundColor: p.surface, borderColor: p.line, opacity: pressed ? 0.8 : 1 }]}>
      <Dot tone={tone} />
      <View style={{ flex: 1 }}>
        <T variant="small" numberOfLines={2}>
          {line}
        </T>
        {s.conn === 'online' && !s.denied ? (
          <T variant="caption" tone="faint">
            End-to-end encrypted via {relayHost(active.relayUrl)}
          </T>
        ) : null}
      </View>
      <Icon name={s.denied ? 'qr' : 'chevron'} size={16} color={p.inkFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: space.lg,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
