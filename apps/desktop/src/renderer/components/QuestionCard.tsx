import React, { useMemo, useState } from 'react';
import type { AskAnswer, AskRequest } from '@agent-nekko/shared';
import { ASK_OTHER_LABEL, isAskComplete } from '@agent-nekko/shared';

/**
 * The agent's question, as something you answer in one pass.
 *
 * Rendered identically in the chat and on the Command Center board, because the
 * same question is the same question wherever you happen to notice it, and the
 * whole point of asking is that answering is quick. Options are buttons rather
 * than a form: the common case is three clicks and a Send, and the typed box is
 * there for the case the agent did not think of.
 *
 * "Skip" is a real answer, not a dismissal. It resolves the call with nothing,
 * which tells the agent to choose for itself and say so — an agent left waiting
 * on a question the user closed is a run that never finishes.
 */
export function QuestionCard({
  request,
  onAnswer,
  onSkip,
  compact = false,
}: {
  request: AskRequest;
  onAnswer: (answers: AskAnswer[]) => void;
  onSkip: () => void;
  /** Board cards are narrower and sit among other cards, so they sit tighter. */
  compact?: boolean;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});

  const answers = useMemo<AskAnswer[]>(
    () =>
      request.questions
        .map((q) => ({ questionId: q.id, labels: picked[q.id] ?? [], note: notes[q.id]?.trim() || undefined }))
        .filter((a) => a.labels.length > 0 || !!a.note),
    [request.questions, picked, notes],
  );
  const complete = isAskComplete(request, answers);

  const toggle = (questionId: string, label: string, multi: boolean) => {
    setPicked((prev) => {
      const current = prev[questionId] ?? [];
      if (!multi) return { ...prev, [questionId]: current.includes(label) ? [] : [label] };
      return {
        ...prev,
        [questionId]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
      };
    });
  };

  return (
    <div
      className="rounded-xl border p-3"
      style={{ borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)', background: 'var(--accent-soft)' }}
      role="group"
      aria-label="The agent is asking a question"
    >
      <div className="mb-2 flex items-center gap-1.5">
        <span className="text-[13px]" aria-hidden>💬</span>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--accent)' }}>
          Before I start
        </span>
        <span className="ml-auto text-[10.5px] text-ink-faint">
          {request.questions.length === 1 ? '1 question' : `${request.questions.length} questions`}
        </span>
      </div>

      <div className={compact ? 'space-y-2.5' : 'space-y-3.5'}>
        {request.questions.map((q) => {
          const chosen = picked[q.id] ?? [];
          const showOther = otherOpen[q.id] || !!notes[q.id];
          return (
            <div key={q.id}>
              <div className="mb-1 flex flex-wrap items-baseline gap-x-1.5">
                <span className="chip shrink-0 text-[9.5px] uppercase tracking-wide">{q.header}</span>
                <span className={`${compact ? 'text-[12px]' : 'text-[12.5px]'} font-medium text-ink`}>{q.question}</span>
                {q.multiSelect && <span className="text-[10px] text-ink-faint">pick any</span>}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const on = chosen.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      className="rounded-lg border px-2 py-1 text-left text-[11.5px] transition-colors"
                      style={{
                        borderColor: on ? 'var(--accent)' : 'var(--line)',
                        background: on ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--surface)',
                        color: on ? 'var(--accent)' : 'var(--ink-soft)',
                      }}
                      aria-pressed={on}
                      title={o.description}
                      onClick={() => toggle(q.id, o.label, !!q.multiSelect)}
                    >
                      <span className="font-medium">{o.label}</span>
                      {o.description && !compact && (
                        <span className="block text-[10.5px] text-ink-faint">{o.description}</span>
                      )}
                    </button>
                  );
                })}
                {!showOther && (
                  <button
                    className="rounded-lg border border-dashed px-2 py-1 text-[11.5px] text-ink-faint hover:text-ink"
                    style={{ borderColor: 'var(--line)' }}
                    onClick={() => setOtherOpen((p) => ({ ...p, [q.id]: true }))}
                  >
                    {ASK_OTHER_LABEL}
                  </button>
                )}
              </div>
              {showOther && (
                <input
                  className="input mt-1.5 py-1 text-[12px]"
                  autoFocus
                  placeholder="Type your answer"
                  value={notes[q.id] ?? ''}
                  onChange={(e) => setNotes((p) => ({ ...p, [q.id]: e.target.value }))}
                />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <button
          className="btn btn-primary px-2.5 py-1 text-[12px]"
          disabled={answers.length === 0}
          onClick={() => onAnswer(answers)}
          title={complete ? undefined : 'Anything left blank goes back as unanswered'}
        >
          Send answer{complete ? '' : 's so far'}
        </button>
        <button
          className="btn btn-ghost px-2 py-1 text-[12px]"
          onClick={onSkip}
          title="Let the agent choose and say which it chose"
        >
          You decide
        </button>
      </div>
    </div>
  );
}
