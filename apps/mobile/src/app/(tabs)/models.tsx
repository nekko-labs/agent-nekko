import { router } from 'expo-router';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GB, PHONE_MODELS, fitFor, formatBytes, recommendedModel, type Fit, type PhoneModel } from '@/lib/catalog';
import { useStore } from '@/lib/store';
import { cancelDownload, deleteModel, downloadModel, newLocalChat, phone, setDefaultModel } from '@/services/phone';
import { Button, Card, Pill, ProgressBar, SectionHeader, T } from '@/ui/kit';
import { space, usePalette } from '@/ui/theme';

const FIT_LABEL: Record<Fit, { label: string; tone: 'success' | 'accent' | 'warning' | 'danger' }> = {
  great: { label: 'Runs great', tone: 'success' },
  ok: { label: 'Runs well', tone: 'accent' },
  tight: { label: 'Tight fit', tone: 'warning' },
  'too-big': { label: 'Too big for this phone', tone: 'danger' },
};

export default function ModelsScreen() {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const s = useStore(phone, (x) => x);
  const recommended = recommendedModel(s.totalMemory);
  const installed = PHONE_MODELS.filter((m) => s.installed.some((i) => i.id === m.id));
  const available = PHONE_MODELS.filter((m) => !s.installed.some((i) => i.id === m.id)).sort(
    (a, b) => (a.id === recommended.id ? -1 : b.id === recommended.id ? 1 : 0),
  );

  return (
    <ScrollView style={{ backgroundColor: p.paper }} contentContainerStyle={{ paddingTop: insets.top + space.md, paddingBottom: insets.bottom + 96 }}>
      <View style={{ paddingHorizontal: space.lg, gap: space.xs }}>
        <T variant="title">On this phone</T>
        <T tone="soft">
          Models that run right here, with no internet and no computer. Nothing you type leaves the phone.
        </T>
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm, flexWrap: 'wrap' }}>
          <Pill icon="lock" label="Private" tone="success" />
          <Pill icon="bolt" label="Works offline" tone="accent" />
          {s.totalMemory ? <Pill icon="models" label={`${Math.round(s.totalMemory / GB)} GB RAM`} /> : null}
        </View>
      </View>

      {!s.supported ? (
        <Card style={{ margin: space.lg }}>
          <T variant="heading">Available in the iOS and Android apps</T>
          <T variant="small" tone="soft" style={{ marginTop: space.xs }}>
            This preview runs in a browser, which can’t load on-device models. Install the app on your phone to download one.
          </T>
        </Card>
      ) : null}

      {s.loadError ? (
        <Card style={{ margin: space.lg, borderColor: p.danger }}>
          <T variant="small" tone="danger">
            {s.loadError}
          </T>
        </Card>
      ) : null}

      {installed.length ? (
        <>
          <SectionHeader title="Downloaded" />
          <View style={{ gap: space.md, paddingHorizontal: space.lg }}>
            {installed.map((m) => (
              <InstalledCard key={m.id} m={m} />
            ))}
          </View>
        </>
      ) : null}

      <SectionHeader title={installed.length ? 'More models' : 'Pick a model'} />
      <View style={{ gap: space.md, paddingHorizontal: space.lg }}>
        {available.map((m) => (
          <AvailableCard key={m.id} m={m} recommended={m.id === recommended.id} />
        ))}
      </View>
      <T variant="caption" tone="faint" style={{ padding: space.lg }}>
        Models download from Hugging Face. Sizes are exact; use Wi-Fi for the bigger ones. Each model keeps its own license.
      </T>
    </ScrollView>
  );
}

function InstalledCard({ m }: { m: PhoneModel }) {
  const s = useStore(phone, (x) => x);
  const isDefault = s.defaultModelId === m.id;
  const loaded = s.loaded?.modelId === m.id;
  const loading = s.loading?.modelId === m.id ? s.loading.progress : null;
  return (
    <Card style={{ gap: space.sm }}>
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <T variant="heading">{m.name}</T>
          <T variant="caption" tone="faint">
            {formatBytes(m.sizeBytes)} · {m.license}
            {loaded ? (s.loaded!.gpu ? ' · running on GPU' : ' · running on CPU') : ''}
          </T>
        </View>
        {isDefault ? <Pill icon="star" label="Default" tone="accent" /> : null}
      </View>
      {loading !== null ? <ProgressBar value={loading} /> : null}
      <View style={styles.actions}>
        <Button
          label="Chat"
          icon="chats"
          style={{ flex: 1 }}
          onPress={() => router.push({ pathname: '/chat/[id]', params: { id: newLocalChat(m.id) } })}
        />
        {!isDefault ? <Button label="Make default" kind="secondary" onPress={() => setDefaultModel(m.id)} /> : null}
        <Button
          label="Delete"
          kind="ghost"
          accessibilityLabel={`Delete ${m.name}`}
          onPress={() =>
            Alert.alert(`Delete ${m.name}?`, `Frees ${formatBytes(m.sizeBytes)}. Your chats stay; download it again to continue them.`, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: () => void deleteModel(m.id) },
            ])
          }
        />
      </View>
      {loaded && s.loaded?.gpuNote ? (
        <T variant="caption" tone="faint">
          {s.loaded.gpuNote}
        </T>
      ) : null}
    </Card>
  );
}

function AvailableCard({ m, recommended }: { m: PhoneModel; recommended: boolean }) {
  const s = useStore(phone, (x) => x);
  const fit = fitFor(m, s.totalMemory);
  const dl = s.downloads[m.id];
  const label = FIT_LABEL[fit];
  return (
    <Card style={{ gap: space.sm }}>
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <T variant="heading">{m.name}</T>
          <T variant="caption" tone="faint">
            {formatBytes(m.sizeBytes)} download · {m.license}
          </T>
        </View>
        {recommended ? <Pill label="Recommended" tone="accent" icon="star" /> : <Pill label={label.label} tone={label.tone} />}
      </View>
      <T variant="small" tone="soft">
        {m.blurb}
      </T>
      {dl?.state === 'downloading' ? (
        <View style={{ gap: space.xs }}>
          <ProgressBar value={dl.total > 0 ? dl.bytes / dl.total : null} />
          <View style={styles.titleRow}>
            <T variant="caption" tone="faint" style={{ flex: 1 }}>
              {formatBytes(dl.bytes)} of {formatBytes(dl.total)}
            </T>
            <Button label="Cancel" kind="ghost" onPress={() => cancelDownload(m.id)} />
          </View>
        </View>
      ) : (
        <>
          {dl?.state === 'error' ? (
            <T variant="small" tone="danger">
              {dl.error}
            </T>
          ) : null}
          <Button
            label={dl?.state === 'error' ? 'Try again' : `Download ${formatBytes(m.sizeBytes)}`}
            icon="download"
            kind={recommended ? 'primary' : 'secondary'}
            disabled={!s.supported || fit === 'too-big'}
            onPress={() => {
              if (fit === 'tight') {
                Alert.alert(`${m.name} is a tight fit`, 'It may be slow or close when other apps are open. Download anyway?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Download', onPress: () => void downloadModel(m) },
                ]);
              } else void downloadModel(m);
            }}
          />
        </>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
});

