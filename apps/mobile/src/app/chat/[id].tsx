import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
// expo-router vendors React Navigation; this is the same context its Stack header writes to.
import { useHeaderHeight } from 'expo-router/build/react-navigation/elements';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BlockView } from '@/chat/BlockView';
import { Composer } from '@/chat/Composer';
import { ApprovalCard, QuestionCard } from '@/chat/Inputs';
import type { ChatModel } from '@/chat/types';
import { useLocalChat } from '@/chat/useLocalChat';
import { useRemoteChat } from '@/chat/useRemoteChat';
import { Icon } from '@/ui/Icon';
import { T } from '@/ui/kit';
import { space, usePalette } from '@/ui/theme';

/** Local chats are created on the phone with a `p_` id; everything else is a computer session. */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return id.startsWith('p_') ? <LocalChatScreen id={id} /> : <RemoteChatScreen id={id} />;
}

function RemoteChatScreen({ id }: { id: string }) {
  return <ChatView chat={useRemoteChat(id)} />;
}

function LocalChatScreen({ id }: { id: string }) {
  return <ChatView chat={useLocalChat(id)} />;
}

function ChatView({ chat }: { chat: ChatModel }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  // Inverted list keeps the newest message at the bottom, by the composer.
  // Keys stay stable as messages append; a provider that reuses a call id
  // across turns gets a suffix instead of a React key collision.
  const data = useMemo(() => {
    const seen = new Map<string, number>();
    const keyed = chat.blocks.map((block) => {
      const base = `${block.kind}:${block.id}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: n ? `${base}#${n}` : base, block };
    });
    return keyed.reverse();
  }, [chat.blocks]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: p.paper }} behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: Platform.OS === 'ios' ? 'center' : 'flex-start', maxWidth: 260 }}>
              <T variant="heading" numberOfLines={1}>
                {chat.title}
              </T>
              <View style={styles.sub}>
                <Icon name={chat.where === 'phone' ? 'phone' : 'computer'} size={11} color={p.inkFaint} />
                <T variant="caption" tone="faint" numberOfLines={1}>
                  {chat.subtitle}
                </T>
              </View>
            </View>
          ),
        }}
      />
      {!chat.ready ? (
        <View style={styles.center}>
          <ActivityIndicator color={p.accent} />
        </View>
      ) : data.length === 0 && !chat.error ? (
        // Outside the inverted list: an inverted list flips its empty component
        // on one axis on iOS/web and both on Android.
        <View style={[styles.center, styles.empty]}>
          <T tone="soft" style={{ textAlign: 'center' }}>
            {chat.where === 'phone'
              ? 'Ask anything. This chat runs on your phone, offline.'
              : 'Ask your computer to do something. It can use its folders, tools and models.'}
          </T>
        </View>
      ) : (
        <FlatList
          inverted
          data={data}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => <BlockView block={item.block} />}
          contentContainerStyle={{ padding: space.lg, gap: space.md }}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={{ gap: space.sm }}>
              {chat.error ? (
                <View style={[styles.note, { backgroundColor: p.dangerSoft }]}>
                  <T variant="small" tone="danger">
                    {chat.error}
                  </T>
                </View>
              ) : null}
              {chat.queued?.length ? (
                <T variant="caption" tone="faint">
                  {chat.queued.length === 1 ? '1 prompt queued after this run' : `${chat.queued.length} prompts queued after this run`}
                </T>
              ) : null}
              {!chat.running && chat.rate ? (
                <T variant="caption" tone="faint">
                  {chat.rate.toFixed(1)} tokens/s
                </T>
              ) : null}
            </View>
          }
        />
      )}
      {chat.approval ? <ApprovalCard approval={chat.approval} onDecide={chat.approve} /> : null}
      {chat.question ? <QuestionCard request={chat.question} onAnswer={chat.answer} /> : null}
      <View style={{ paddingBottom: insets.bottom }}>
        <Composer
          running={chat.running}
          blocked={chat.blocked}
          placeholder={chat.where === 'phone' ? 'Message the model on this phone' : 'Message your computer'}
          thinking={chat.thinking}
          queueing={chat.where === 'computer'}
          onSend={chat.send}
          onStop={chat.stop}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  sub: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  note: { borderRadius: 10, padding: space.md },
  empty: { paddingVertical: space.xxl, paddingHorizontal: space.xl },
});
