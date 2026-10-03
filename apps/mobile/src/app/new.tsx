import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { findModel } from '@/lib/catalog';
import { AUTO_MODEL_ID, Channels, type ModelInfo, type Session } from '@/lib/protocol';
import { useStore } from '@/lib/store';
import { computers, loadModels, remote } from '@/services/computers';
import { newLocalChat, phone } from '@/services/phone';
import { Icon } from '@/ui/Icon';
import { Button, Card, SectionHeader, T } from '@/ui/kit';
import { radius, space, usePalette } from '@/ui/theme';

/** Where should this chat run? Your computer (pick model + folder) or this phone. */
export default function NewChatSheet() {
  const p = usePalette();
  const c = useStore(computers, (x) => x);
  const ph = useStore(phone, (x) => x);
  const active = c.computers.find((x) => x.id === c.activeId);
  const online = c.conn === 'online';

  const providers = c.providers.filter((x) => x.enabled);
  const [providerId, setProviderId] = useState<string | undefined>(c.defaults.defaultProviderId);
  const [modelId, setModelId] = useState<string | undefined>(c.defaults.defaultModelId);
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!online || !providerId) return;
    let live = true;
    setModels(null);
    loadModels(providerId)
      .then((m) => live && setModels(m))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [online, providerId]);

  const providerLabel = providers.find((x) => x.id === providerId)?.label;
  const modelLabel = modelId && modelId !== AUTO_MODEL_ID ? models?.find((m) => m.id === modelId)?.name ?? modelId : undefined;

  const startRemote = async () => {
    if (!providerId || !modelId || modelId === AUTO_MODEL_ID) {
      setPicking(true);
      setError('Pick a model for this chat.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await remote().call<Session>(Channels.sessionCreate, workspaceId);
      await remote().call(Channels.sessionSetOptions, session.id, { providerId, modelId });
      router.dismiss();
      router.push({ pathname: '/chat/[id]', params: { id: session.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const startLocal = (id: string) => {
    const chatId = newLocalChat(id);
    router.dismiss();
    router.push({ pathname: '/chat/[id]', params: { id: chatId } });
  };

  return (
    <ScrollView style={{ backgroundColor: p.paper }} contentContainerStyle={{ paddingBottom: space.xxl }}>
      <SectionHeader title={active ? `On ${active.name}` : 'On your computer'} />
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        {!active ? (
          <Card style={{ gap: space.sm }}>
            <T variant="small" tone="soft">
              Pair your computer to run chats there, with its models, files and tools.
            </T>
            <Button label="Pair a computer" icon="qr" kind="secondary" onPress={() => router.push('/pair')} />
          </Card>
        ) : !online ? (
          <Card>
            <T variant="small" tone="soft">
              {active.name} is {c.conn === 'connecting' ? 'connecting…' : 'offline'}. Start a chat on this phone instead, or open Agent Nekko on your computer.
            </T>
          </Card>
        ) : (
          <Card style={{ gap: space.md }}>
            <Pressable accessibilityRole="button" onPress={() => setPicking((v) => !v)} style={styles.field}>
              <Icon name="brain" size={18} color={p.accent} />
              <View style={{ flex: 1 }}>
                <T variant="caption" tone="faint">
                  Model
                </T>
                <T numberOfLines={1}>{modelLabel ? `${modelLabel}${providerLabel ? ` · ${providerLabel}` : ''}` : 'Choose a model'}</T>
              </View>
              <Icon name="chevron" size={14} color={p.inkFaint} />
            </Pressable>
            {picking ? (
              <View style={{ gap: space.sm }}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                  {providers.map((pr) => (
                    <Chip key={pr.id} label={pr.label} selected={pr.id === providerId} onPress={() => (setProviderId(pr.id), setModelId(undefined))} />
                  ))}
                </ScrollView>
                {models === null ? (
                  <ActivityIndicator color={p.accent} />
                ) : models.length === 0 ? (
                  <T variant="small" tone="faint">
                    No models found for this provider on your computer.
                  </T>
                ) : (
                  <View style={{ maxHeight: 260 }}>
                    <ScrollView nestedScrollEnabled>
                      {models.map((m) => (
                        <Pressable
                          key={m.id}
                          accessibilityRole="button"
                          onPress={() => (setModelId(m.id), setPicking(false), setError(''))}
                          style={[styles.option, m.id === modelId && { backgroundColor: p.accentSoft }]}>
                          <T variant="small" numberOfLines={1} style={{ flex: 1 }}>
                            {m.name || m.id}
                          </T>
                          {m.loaded ? <T variant="caption" tone="success">loaded</T> : null}
                        </Pressable>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </View>
            ) : null}
            {c.workspaces.length ? (
              <View style={{ gap: space.sm }}>
                <View style={styles.field}>
                  <Icon name="folder" size={18} color={p.accent} />
                  <T variant="caption" tone="faint">
                    Folder
                  </T>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
                  <Chip label="None" selected={!workspaceId} onPress={() => setWorkspaceId(undefined)} />
                  {c.workspaces.map((w) => (
                    <Chip key={w.id} label={w.name} selected={w.id === workspaceId} onPress={() => setWorkspaceId(w.id)} />
                  ))}
                </ScrollView>
              </View>
            ) : null}
            {error ? (
              <T variant="small" tone="danger">
                {error}
              </T>
            ) : null}
            <Button label={`Start on ${active.name}`} icon="computer" busy={busy} onPress={() => void startRemote()} />
          </Card>
        )}
      </View>

      <SectionHeader title="On this phone" />
      <View style={{ paddingHorizontal: space.lg, gap: space.sm }}>
        {ph.installed.length === 0 ? (
          <Card style={{ gap: space.sm }}>
            <T variant="small" tone="soft">
              No model on this phone yet. Download one to chat offline and in private.
            </T>
            <Button label="Choose a model" kind="secondary" icon="download" onPress={() => (router.dismiss(), router.navigate('/models'))} />
          </Card>
        ) : (
          ph.installed.map((m) => (
            <Pressable key={m.id} accessibilityRole="button" onPress={() => startLocal(m.id)}>
              {({ pressed }) => (
                <Card style={[styles.field, { opacity: pressed ? 0.8 : 1 }]}>
                  <Icon name="phone" size={18} color={p.success} />
                  <View style={{ flex: 1 }}>
                    <T variant="heading">{findModel(m.id)?.name ?? m.id}</T>
                    <T variant="caption" tone="faint">
                      {ph.defaultModelId === m.id ? 'Default · ' : ''}Offline and private
                    </T>
                  </View>
                  <Icon name="chevron" size={14} color={p.inkFaint} />
                </Card>
              )}
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
  );
}

function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: selected ? p.accent : p.surface2 }]}>
      <T variant="small" style={{ color: selected ? p.accentInk : p.ink, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  field: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  option: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 10, paddingHorizontal: space.sm, borderRadius: radius.sm },
  chip: { paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.pill, maxWidth: 200 },
});
