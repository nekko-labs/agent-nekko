import { memo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { Block } from '@/lib/transcript';
import { Icon } from '@/ui/Icon';
import { T } from '@/ui/kit';
import { Markdown } from '@/ui/Markdown';
import { radius, space, type, usePalette } from '@/ui/theme';

export const BlockView = memo(function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'user':
      return <UserBubble text={block.text} images={block.images} />;
    case 'assistant':
      return <Reply text={block.text} reasoning={block.reasoning} streaming={block.streaming} interrupted={block.interrupted} />;
    case 'tool':
      return <ToolRow block={block} />;
  }
});

function UserBubble({ text, images }: { text: string; images?: number }) {
  const p = usePalette();
  return (
    <View style={[styles.user, { backgroundColor: p.userBubble }]}>
      <Text style={[type.body, { color: p.userInk }]} selectable>
        {text}
      </Text>
      {images ? (
        <T variant="caption" style={{ color: p.userInk, opacity: 0.7, marginTop: 4 }}>
          {images === 1 ? '1 image' : `${images} images`}
        </T>
      ) : null}
    </View>
  );
}

function Reply({ text, reasoning, streaming, interrupted }: { text: string; reasoning?: string; streaming?: boolean; interrupted?: boolean }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const thinkingOnly = streaming && !text && !!reasoning;
  return (
    <View style={styles.reply}>
      {reasoning ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((v) => !v)} style={styles.reasoningHead}>
          <Icon name="brain" size={14} color={p.inkFaint} />
          <T variant="caption" tone="faint">
            {thinkingOnly ? 'Thinking…' : open ? 'Hide reasoning' : 'Show reasoning'}
          </T>
        </Pressable>
      ) : null}
      {reasoning && (open || thinkingOnly) ? (
        <View style={[styles.reasoning, { borderLeftColor: p.line }]}>
          <T variant="small" tone="faint" numberOfLines={open ? undefined : 4}>
            {reasoning}
          </T>
        </View>
      ) : null}
      {text ? <Markdown source={text} /> : streaming && !reasoning ? <ActivityIndicator color={p.accent} style={{ alignSelf: 'flex-start' }} /> : null}
      {interrupted ? (
        <T variant="caption" tone="faint">
          Stopped before finishing.
        </T>
      ) : null}
    </View>
  );
}

function ToolRow({ block }: { block: Extract<Block, { kind: 'tool' }> }) {
  const p = usePalette();
  const [open, setOpen] = useState(false);
  const color = { running: p.running, waiting: p.warning, ok: p.success, error: p.danger }[block.status];
  return (
    <View style={[styles.tool, { backgroundColor: p.surface, borderColor: p.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${block.label}, ${block.status}`}
        disabled={!block.output}
        onPress={() => setOpen((v) => !v)}
        style={styles.toolHead}>
        {block.status === 'running' ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <Icon name={block.status === 'ok' ? 'check' : block.status === 'waiting' ? 'warning' : block.status === 'error' ? 'close' : 'tool'} size={14} color={color} />
        )}
        <T variant="small" tone="soft" numberOfLines={open ? undefined : 1} style={{ flex: 1 }}>
          {block.label}
        </T>
        {block.output ? <Icon name="chevron" size={12} color={p.inkFaint} /> : null}
      </Pressable>
      {open && block.output ? (
        <Text style={[type.mono, { color: p.inkSoft, paddingHorizontal: space.md, paddingBottom: space.md }]} selectable numberOfLines={40}>
          {block.output}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  user: { alignSelf: 'flex-end', maxWidth: '85%', borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.md, paddingVertical: 10 },
  reply: { gap: space.sm },
  reasoningHead: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 2 },
  reasoning: { borderLeftWidth: 2, paddingLeft: space.md },
  tool: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: 10 },
});
