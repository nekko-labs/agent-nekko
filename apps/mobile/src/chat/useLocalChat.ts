import { useState } from 'react';

import { findModel } from '@/lib/catalog';
import { useStore } from '@/lib/store';
import type { Block } from '@/lib/transcript';
import { isInstalled, phone, sendLocal, setChatOptions, stopLocal } from '@/services/phone';
import type { ChatModel } from './types';

/** A chat with the model on this phone. Same shape as a computer chat. */
export function useLocalChat(chatId: string): ChatModel {
  const chat = useStore(phone, (s) => s.chats.find((c) => c.id === chatId));
  const live = useStore(phone, (s) => (s.live?.chatId === chatId ? s.live : undefined));
  const busyElsewhere = useStore(phone, (s) => !!s.live && s.live.chatId !== chatId);
  const loading = useStore(phone, (s) => (s.loading && chat && s.loading.modelId === chat.modelId ? s.loading.progress : undefined));
  const installed = useStore(phone, (s) => (chat ? s.installed.some((m) => m.id === chat.modelId) : false));
  const [error, setError] = useState<string>();
  const meta = chat ? findModel(chat.modelId) : undefined;

  const blocks: Block[] = (chat?.messages ?? []).map((m) =>
    m.role === 'user'
      ? { kind: 'user', id: m.id, text: m.content, at: m.at }
      : { kind: 'assistant', id: m.id, text: m.content, reasoning: m.reasoning, interrupted: m.interrupted },
  );
  if (live) {
    blocks.push({
      kind: 'assistant',
      id: 'live',
      text: live.content || (loading !== undefined ? `Loading ${meta?.name ?? 'the model'}… ${Math.round(loading * 100)}%` : ''),
      reasoning: live.reasoning || undefined,
      streaming: true,
    });
  }
  const last = chat?.messages[chat.messages.length - 1];

  return {
    ready: true,
    title: chat?.title ?? 'Chat',
    subtitle: `${meta?.name ?? 'On-device model'} · on this phone`,
    where: 'phone',
    blocks,
    running: !!live,
    error: !chat ? 'This chat was deleted.' : error,
    blocked: !chat
      ? 'This chat was deleted.'
      : !installed || !isInstalled(chat.modelId)
        ? `${meta?.name ?? 'This model'} isn’t on this phone any more. Download it again from On this phone.`
        : busyElsewhere
          ? 'Another chat on this phone is still writing.'
          : undefined,
    rate: last?.role === 'assistant' ? last.tps : undefined,
    thinking: meta?.thinking && chat ? { on: chat.thinking, toggle: () => setChatOptions(chatId, { thinking: !chat.thinking }) } : undefined,
    send: async (text) => {
      setError(undefined);
      try {
        await sendLocal(chatId, text);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    stop: () => void stopLocal(),
    approve: async () => {},
    answer: async () => {},
  };
}
