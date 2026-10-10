import { router } from 'expo-router';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { relayHost } from '@/lib/pairing';
import { useStore } from '@/lib/store';
import { computers, connect, forgetComputer, renameComputer, type Computer } from '@/services/computers';
import { Icon } from '@/ui/Icon';
import { Button, Card, Dot, Pill, SectionHeader, T } from '@/ui/kit';
import { space, usePalette } from '@/ui/theme';
import { ago } from '@/ui/time';

export default function ComputersScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const s = useStore(computers, (x) => x);

  return (
    <ScrollView style={{ backgroundColor: p.paper }} contentContainerStyle={{ paddingTop: insets.top + space.md, paddingBottom: insets.bottom + 96 }}>
      <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
        <T variant="title">Computers</T>
        <T tone="soft">Run Nekko Agent on your computer and steer it from here: start chats, follow runs, approve what it wants to do.</T>
      </View>

      {s.computers.length ? <SectionHeader title="Paired" /> : null}
      <View style={{ gap: space.md, paddingHorizontal: space.lg }}>
        {s.computers.map((c) => (
          <ComputerCard key={c.id} c={c} />
        ))}
        <Button label={s.computers.length ? 'Pair another computer' : 'Pair a computer'} icon="qr" onPress={() => router.push('/pair')} style={{ marginTop: space.sm }} />
      </View>

      <SectionHeader title="How it works" />
      <Card style={{ marginHorizontal: space.lg, gap: space.md }}>
        <Step n={1} text="On your computer, open Nekko Agent → Settings → Remote access and turn it on." />
        <Step n={2} text="Choose “Pair a device” and scan the QR with this app. The code works once and expires in 10 minutes." />
        <Step n={3} text="Your computer dials out to a relay; it never opens a port. Everything is end-to-end encrypted with a key only your devices hold." />
        <Step n={4} text="Remove this phone any time from the same screen on your computer. It loses access immediately." />
      </Card>
    </ScrollView>
  );
}

function ComputerCard({ c }: { c: Computer }) {
  const p = usePalette();
  const s = useStore(computers, (x) => x);
  const active = s.activeId === c.id;
  const state = active ? (s.denied ? 'denied' : s.conn) : 'idle';
  const tone = state === 'online' ? 'success' : state === 'denied' ? 'danger' : state === 'idle' ? 'faint' : 'warning';
  const label = {
    online: 'Online',
    connecting: 'Connecting…',
    offline: 'Offline',
    denied: 'Not paired',
    idle: 'Not connected',
  }[state];

  return (
    <Card style={{ gap: space.md }}>
      <View style={styles.row}>
        <View style={[styles.icon, { backgroundColor: p.accentSoft }]}>
          <Icon name="computer" size={20} color={p.accent} />
        </View>
        <View style={{ flex: 1 }}>
          <T variant="heading">{c.name}</T>
          <View style={[styles.row, { gap: space.xs }]}>
            <Dot tone={tone} />
            <T variant="caption" tone="soft">
              {label} · {relayHost(c.relayUrl)} · paired {ago(c.pairedAt)} ago
            </T>
          </View>
        </View>
        {active ? <Pill label="Active" tone="accent" /> : null}
      </View>
      {active && s.lastError && state === 'online' ? (
        <T variant="caption" tone="danger">
          {s.lastError}
        </T>
      ) : null}
      <View style={styles.row}>
        {active ? (
          state === 'denied' ? (
            <Button label="Pair again" icon="qr" style={{ flex: 1 }} onPress={() => router.push('/pair')} />
          ) : (
            <Button label="Reconnect" icon="refresh" kind="secondary" style={{ flex: 1 }} onPress={() => void connect(c.id)} />
          )
        ) : (
          <Button label="Use this computer" style={{ flex: 1 }} onPress={() => void connect(c.id)} />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`More options for ${c.name}`}
          hitSlop={8}
          onPress={() => manage(c)}
          style={({ pressed }) => [styles.more, { backgroundColor: p.surface2, opacity: pressed ? 0.7 : 1 }]}>
          <T variant="heading" tone="soft">
            ⋯
          </T>
        </Pressable>
      </View>
    </Card>
  );
}

function manage(c: Computer) {
  const forget = () =>
    Alert.alert(`Forget ${c.name}?`, 'This phone deletes the pairing key. To be safe, also remove the phone on your computer (Settings → Remote access).', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => void forgetComputer(c.id) },
    ]);
  const rename = () => {
    if (Platform.OS === 'ios') {
      Alert.prompt('Rename computer', undefined, (name) => name && void renameComputer(c.id, name), 'plain-text', c.name);
    } else {
      // Android has no prompt dialog; cycle through sensible names instead of a whole form.
      const names = ['Work PC', 'Home PC', 'Laptop', 'Desktop', 'Mac', 'My computer'];
      const next = names[(names.indexOf(c.name) + 1) % names.length];
      void renameComputer(c.id, next);
    }
  };
  Alert.alert(c.name, undefined, [
    { text: 'Rename', onPress: rename },
    { text: 'Forget this computer', style: 'destructive', onPress: forget },
    { text: 'Cancel', style: 'cancel' },
  ]);
}

function Step({ n, text }: { n: number; text: string }) {
  const p = usePalette();
  return (
    <View style={[styles.row, { alignItems: 'flex-start' }]}>
      <View style={[styles.step, { backgroundColor: p.accentSoft }]}>
        <T variant="caption" tone="accent" style={{ fontWeight: '700' }}>
          {n}
        </T>
      </View>
      <T variant="small" tone="soft" style={{ flex: 1 }}>
        {text}
      </T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  icon: { width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  more: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  step: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
});
