import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { parsePairingLink, relayHost, type PairingLink } from '@/lib/pairing';
import { pairComputer } from '@/services/computers';
import { askForPush } from '@/services/push';
import { Icon } from '@/ui/Icon';
import { Button, Card, T } from '@/ui/kit';
import { radius, space, usePalette } from '@/ui/theme';

/**
 * Pair with a computer: scan the QR from Settings → Remote access, or paste
 * the link. Opening an `agent-nekko-pair:` link from the camera app lands here
 * too, with the link prefilled.
 */
export default function PairScreen() {
  const p = usePalette();
  const params = useLocalSearchParams<{ link?: string }>();
  const [permission, requestPermission] = useCameraPermissions();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<PairingLink | null>(null);
  const handled = useRef(false);

  const commit = useCallback(async (raw: string) => {
    if (handled.current) return;
    const link = parsePairingLink(raw);
    if (!link) {
      setError('That isn’t a pairing link. On your computer: Settings → Remote access → Pair a device.');
      return;
    }
    handled.current = true;
    setError('');
    setBusy(link);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    try {
      await pairComputer(link);
      await askForPush();
      // Opened from a deep link there's no modal stack to dismiss.
      if (router.canDismiss()) router.dismissAll();
      router.replace('/');
    } catch (e) {
      handled.current = false;
      setBusy(null);
      setError((e as Error).message || 'Pairing failed. Try a fresh QR.');
    }
  }, []);

  useEffect(() => {
    if (params.link) void commit(params.link);
  }, [params.link, commit]);

  const canScan = Platform.OS !== 'web';

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg }} keyboardShouldPersistTaps="handled">
        {busy ? (
          <Card style={{ gap: space.sm, alignItems: 'center', paddingVertical: space.xxl }}>
            <Icon name="lock" size={28} color={p.accent} />
            <T variant="heading">Pairing securely…</T>
            <T variant="small" tone="soft" style={{ textAlign: 'center' }}>
              Deriving the encryption key and saying hello to your computer through {relayHost(busy.relayUrl)}.
            </T>
          </Card>
        ) : canScan ? (
          <View style={[styles.camera, { borderColor: p.line, backgroundColor: p.surface }]}>
            {permission?.granted ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={({ data }) => void commit(data)}
              />
            ) : (
              <View style={styles.cameraEmpty}>
                <Icon name="qr" size={36} color={p.accent} />
                <T variant="small" tone="soft" style={{ textAlign: 'center' }}>
                  {permission?.canAskAgain === false
                    ? 'Camera access is off for Agent Nekko. Turn it on in Settings, or paste the link below.'
                    : 'Scan the pairing QR shown on your computer.'}
                </T>
                {permission?.canAskAgain !== false ? <Button label="Allow camera" onPress={() => void requestPermission()} /> : null}
              </View>
            )}
            {permission?.granted ? <View pointerEvents="none" style={[styles.reticle, { borderColor: p.accent }]} /> : null}
          </View>
        ) : null}

        {!busy ? (
          <>
            <T variant="small" tone="soft">
              On your computer: Agent Nekko → Settings → Remote access → Pair a device. {canScan ? 'Or copy the link and paste it here:' : 'Copy the pairing link and paste it here:'}
            </T>
            <TextInput
              value={text}
              onChangeText={(v) => {
                setText(v);
                setError('');
              }}
              placeholder="agent-nekko-pair:?relay=…"
              placeholderTextColor={p.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={[styles.input, { color: p.ink, backgroundColor: p.surface, borderColor: error ? p.danger : p.line }]}
              accessibilityLabel="Pairing link"
            />
            {error ? (
              <T variant="small" tone="danger">
                {error}
              </T>
            ) : null}
            <View style={{ flexDirection: 'row', gap: space.sm }}>
              <Button
                label="Paste"
                kind="secondary"
                icon="link"
                onPress={async () => {
                  const v = await Clipboard.getStringAsync();
                  setText(v);
                  if (parsePairingLink(v)) void commit(v);
                }}
              />
              <Button label="Pair" style={{ flex: 1 }} disabled={!text.trim()} onPress={() => void commit(text)} />
            </View>
            <T variant="caption" tone="faint">
              The link holds a one-time code (valid 10 minutes) and the key that encrypts everything between this phone and your computer. Treat it like a password.
            </T>
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  camera: { aspectRatio: 1, borderRadius: radius.lg, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth },
  cameraEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.md, padding: space.xl },
  reticle: { position: 'absolute', top: '18%', left: '18%', right: '18%', bottom: '18%', borderWidth: 2, borderRadius: radius.lg },
  input: { minHeight: 72, borderWidth: 1, borderRadius: radius.md, padding: space.md, fontSize: 14, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
