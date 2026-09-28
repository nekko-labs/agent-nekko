import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '@agent-nekko/shared';
import { isAskComplete } from '@agent-nekko/shared';
import { toAnswers, togglePick } from './QuestionCard.js';

const questions: AskQuestion[] = [
  { id: 'q1', header: 'Scope', question: 'How far?', options: [{ label: 'Parser' }, { label: 'Module' }] },
  {
    id: 'q2',
    header: 'Tests',
    question: 'Which tests?',
    options: [{ label: 'Unit' }, { label: 'E2E' }],
    multiSelect: true,
  },
];

describe('togglePick', () => {
  it('replaces the pick when only one answer is allowed', () => {
    expect(togglePick([], 'Parser', false)).toEqual(['Parser']);
    expect(togglePick(['Parser'], 'Module', false)).toEqual(['Module']);
  });

  it('clears a single-select pick when it is chosen again', () => {
    // Otherwise there is no way back to "unanswered" once a radio is touched,
    // and the card would force an answer the user did not mean to give.
    expect(togglePick(['Parser'], 'Parser', false)).toEqual([]);
  });

  it('accumulates when the options are not exclusive', () => {
    expect(togglePick(['Unit'], 'E2E', true)).toEqual(['Unit', 'E2E']);
    expect(togglePick(['Unit', 'E2E'], 'Unit', true)).toEqual(['E2E']);
  });

  it('does not mutate the array it was given', () => {
    const current = ['Unit'];
    togglePick(current, 'E2E', true);
    expect(current).toEqual(['Unit']);
  });
});

describe('toAnswers', () => {
  it('carries picks and typed text together', () => {
    const out = toAnswers(questions, { q2: ['Unit', 'E2E'] }, { q2: 'and a smoke test' });
    expect(out).toEqual([{ questionId: 'q2', labels: ['Unit', 'E2E'], note: 'and a smoke test' }]);
  });

  it('omits a question nobody touched rather than sending it blank', () => {
    // An entry with no labels and no note would read as "(not answered)" to the
    // model either way, but it would make isAskComplete call the card finished.
    const out = toAnswers(questions, { q1: ['Parser'] }, {});
    expect(out.map((a) => a.questionId)).toEqual(['q1']);
    expect(isAskComplete({ callId: 'c', askedAt: 0, questions }, out)).toBe(false);
  });

  it('treats whitespace as no answer at all', () => {
    expect(toAnswers(questions, {}, { q1: '   ' })).toEqual([]);
  });

  it('is complete once every question has something against it', () => {
    const out = toAnswers(questions, { q1: ['Module'] }, { q2: 'neither' });
    expect(isAskComplete({ callId: 'c', askedAt: 0, questions }, out)).toBe(true);
  });

  it('keeps a pick made on the last question in the same event as the send', () => {
    // The wizard sends from refs, not from the render that fired it: Enter on
    // the final question both chooses and sends, and reading the render-time
    // snapshot dropped the option the user had just hit Enter on.
    const live = { q1: ['Parser'] };
    const afterLastPick = { ...live, q2: togglePick([], 'E2E', true) };
    const out = toAnswers(questions, afterLastPick, {});
    expect(out).toContainEqual({ questionId: 'q2', labels: ['E2E'], note: undefined });
  });
});
