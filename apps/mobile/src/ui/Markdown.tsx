import { memo, useMemo } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { parseBlocks, parseInline, type MdSpan } from '@/lib/markdown';
import { radius, space, type, usePalette } from './theme';

function Inline({ text, color, style }: { text: string; color: string; style?: object }) {
  const p = usePalette();
  const spans = useMemo(() => parseInline(text), [text]);
  return (
    <Text style={[type.body, { color }, style]} selectable>
      {spans.map((s: MdSpan, i) =>
        s.code ? (
          <Text key={i} style={[type.mono, { backgroundColor: p.surface2, color: p.ink }]}>
            {` ${s.text} `}
          </Text>
        ) : s.href ? (
          <Text key={i} style={{ color: p.accent, textDecorationLine: 'underline' }} onPress={() => Linking.openURL(s.href!)}>
            {s.text}
          </Text>
        ) : (
          <Text key={i} style={{ fontWeight: s.bold ? '700' : undefined, fontStyle: s.italic ? 'italic' : undefined }}>
            {s.text}
          </Text>
        ),
      )}
    </Text>
  );
}

export const Markdown = memo(function Markdown({ source, color }: { source: string; color?: string }) {
  const p = usePalette();
  const ink = color ?? p.ink;
  const blocks = useMemo(() => parseBlocks(source), [source]);
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'code':
            return (
              <ScrollView key={i} horizontal style={[styles.code, { backgroundColor: p.code, borderColor: p.line }]} contentContainerStyle={{ padding: space.md }}>
                <Text style={[type.mono, { color: p.ink }]} selectable>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case 'heading':
            return <Inline key={i} text={b.text} color={ink} style={{ fontWeight: '700', fontSize: b.level <= 2 ? 18 : 16 }} />;
          case 'list':
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((item, j) => (
                  <View key={j} style={{ flexDirection: 'row', gap: space.sm }}>
                    <Text style={[type.body, { color: p.inkFaint, minWidth: 16 }]}>{b.ordered ? `${j + 1}.` : '•'}</Text>
                    <View style={{ flex: 1 }}>
                      <Inline text={item} color={ink} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: p.line, paddingLeft: space.md }}>
                <Inline text={b.text} color={p.inkSoft} />
              </View>
            );
          default:
            return <Inline key={i} text={b.text} color={ink} />;
        }
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  code: { borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth, maxHeight: 360 },
});
