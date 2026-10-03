/** Cards that ask the user for something: tool approvals and the agent's questions. */
import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import type { AskAnswer, AskRequest } from '@/lib/protocol';
import { toolLabel, type Approval } from '@/lib/transcript';
import { Icon } from '@/ui/Icon';
import { Button, Pill, T } from '@/ui/kit';
import { radius, space, usePalette } from '@/ui/theme';

export function ApprovalCard({ approval, onDecide }: { approval: Approval; onDecide: (ok: boolean) => Promise<void> }) {
  const p = usePalette();
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  useEffect(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [approval.call.id]);
  const tone = approval.severity === 'high' ? 'danger' : approval.severity === 'medium' ? 'warning' : 'accent';
  const edge = { danger: p.danger, warning: p.warning, accent: p.accent }[tone];
  const command = typeof approval.call.input?.command === 'string' ? (approval.call.input.command as string) : null;
  const decide = async (ok: boolean) => {
    setBusy(ok ? 'yes' : 'no');
    try {
      await onDecide(ok);
    } finally {
      setBusy(null);
    }
  };
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: edge }]}>
      <View style={styles.row}>
        <Icon name="warning" size={16} color={edge} />
        <T variant="heading" style={{ flex: 1 }}>
          Allow this?
        </T>
        <Pill label={`${approval.severity} risk`} tone={tone} />
      </View>
      <T variant="small">{command ? 'Run this command on your computer:' : toolLabel(approval.call)}</T>
      {command ? (
        <View style={[styles.code, { backgroundColor: p.code }]}>
          <T variant="mono" numberOfLines={6} selectable>
            {command}
          </T>
        </View>
      ) : null}
      {approval.reason ? (
        <T variant="caption" tone="soft">
          {approval.reason}
        </T>
      ) : null}
      <View style={styles.row}>
        <Button label="Deny" kind="secondary" style={{ flex: 1 }} busy={busy === 'no'} disabled={!!busy} onPress={() => void decide(false)} />
        <Button label="Approve" style={{ flex: 1 }} busy={busy === 'yes'} disabled={!!busy} onPress={() => void decide(true)} />
      </View>
    </View>
  );
}

export function QuestionCard({ request, onAnswer }: { request: AskRequest; onAnswer: (a: AskAnswer[]) => Promise<void> }) {
  const p = usePalette();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const complete = request.questions.every((q) => (picked[q.id]?.length ?? 0) > 0 || (notes[q.id]?.trim().length ?? 0) > 0);

  const toggle = (qid: string, label: string, multi?: boolean) =>
    setPicked((s) => {
      const cur = s[qid] ?? [];
      const next = multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : cur[0] === label ? [] : [label];
      return { ...s, [qid]: next };
    });

  const submit = async (answers: AskAnswer[]) => {
    setBusy(true);
    try {
      await onAnswer(answers);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.accent }]}>
      <View style={styles.row}>
        <Icon name="question" size={16} color={p.accent} />
        <T variant="heading">Nekko has a question</T>
      </View>
      {request.questions.map((q) => (
        <View key={q.id} style={{ gap: space.sm }}>
          <T variant="small" style={{ fontWeight: '600' }}>
            {q.question}
          </T>
          <View style={styles.options}>
            {q.options.map((o) => {
              const on = picked[q.id]?.includes(o.label);
              return (
                <Pressable
                  key={o.label}
                  accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                  accessibilityState={{ checked: !!on }}
                  onPress={() => toggle(q.id, o.label, q.multiSelect)}
                  style={[styles.option, { backgroundColor: on ? p.accent : p.surface2 }]}>
                  <T variant="small" style={{ color: on ? p.accentInk : p.ink, fontWeight: '600' }}>
                    {o.label}
                  </T>
                  {o.description ? (
                    <T variant="caption" style={{ color: on ? p.accentInk : p.inkSoft }}>
                      {o.description}
                    </T>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
          <TextInput
            placeholder="Or type an answer"
            placeholderTextColor={p.inkFaint}
            value={notes[q.id] ?? ''}
            onChangeText={(v) => setNotes((s) => ({ ...s, [q.id]: v }))}
            style={[styles.note, { color: p.ink, borderColor: p.line }]}
          />
        </View>
      ))}
      <View style={styles.row}>
        <Button label="Skip" kind="secondary" disabled={busy} onPress={() => void submit([])} />
        <Button
          label="Answer"
          style={{ flex: 1 }}
          busy={busy}
          disabled={!complete}
          onPress={() =>
            void submit(
              request.questions.map((q) => ({ questionId: q.id, labels: picked[q.id] ?? [], note: notes[q.id]?.trim() || undefined })),
            )
          }
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg, gap: space.md, marginHorizontal: space.md, marginBottom: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  code: { borderRadius: radius.sm, padding: space.md },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  option: { borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, maxWidth: '100%' },
  note: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space.md, paddingVertical: 8, fontSize: 15 },
});
