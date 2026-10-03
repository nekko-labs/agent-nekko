import { useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Icon } from '@/ui/Icon';
import { T } from '@/ui/kit';
import { radius, space, usePalette } from '@/ui/theme';

export function Composer({
  running,
  blocked,
  placeholder,
  thinking,
  queueing,
  onSend,
  onStop,
}: {
  running: boolean;
  blocked?: string;
  placeholder: string;
  thinking?: { on: boolean; toggle(): void };
  /** Sending while a run is going queues the prompt (computer chats). */
  queueing?: boolean;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}) {
  const p = usePalette();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const canSend = !!text.trim() && !blocked && !sending && (!running || queueing);

  const send = async () => {
    if (!canSend) return;
    const value = text.trim();
    setSending(true);
    setText('');
    setError('');
    try {
      await onSend(value);
    } catch (e) {
      setText(value); // keep what they typed if it didn't go
      setError((e as Error).message || 'Couldn’t send that.');
    } finally {
      setSending(false);
    }
  };

  const showStop = running && !text.trim();

  return (
    <View style={[styles.wrap, { borderTopColor: p.line, backgroundColor: p.paper }]}>
      {blocked || error ? (
        <T variant="caption" tone={blocked ? 'warning' : 'danger'} style={{ paddingHorizontal: space.xs, paddingBottom: space.xs }}>
          {blocked ?? error}
        </T>
      ) : null}
      <View style={[styles.box, { backgroundColor: p.surface, borderColor: p.line }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={running && queueing ? 'Queue a follow-up…' : placeholder}
          placeholderTextColor={p.inkFaint}
          multiline
          style={[styles.input, { color: p.ink }]}
          accessibilityLabel="Message"
          submitBehavior={Platform.OS === 'web' ? 'submit' : 'newline'}
          onSubmitEditing={Platform.OS === 'web' ? () => void send() : undefined}
        />
        <View style={styles.row}>
          {thinking ? (
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: thinking.on }}
              onPress={thinking.toggle}
              style={[styles.chip, { backgroundColor: thinking.on ? p.accentSoft : p.surface2 }]}>
              <Icon name="brain" size={14} color={thinking.on ? p.accent : p.inkFaint} />
              <T variant="caption" tone={thinking.on ? 'accent' : 'faint'} style={{ fontWeight: '600' }}>
                Think
              </T>
            </Pressable>
          ) : (
            <View />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showStop ? 'Stop' : 'Send'}
            onPress={showStop ? onStop : () => void send()}
            disabled={!showStop && !canSend}
            style={[styles.send, { backgroundColor: showStop ? p.danger : canSend ? p.accent : p.surface2 }]}>
            <Icon name={showStop ? 'stop' : 'send'} size={16} color={showStop || canSend ? '#fff' : p.inkFaint} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  box: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md, paddingTop: 10, paddingBottom: space.sm, gap: space.xs },
  input: { fontSize: 16, lineHeight: 22, maxHeight: 160, minHeight: 24, padding: 0 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: radius.pill },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
