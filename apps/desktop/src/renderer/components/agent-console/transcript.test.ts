import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agent-nekko/shared';
import { collectSessionPrUrls, extractPrUrls } from '../../../../../../packages/shared/src/pr.js';
import { estimateRowHeight, fmtDateTime, fmtTime, toTranscriptRows } from './transcript.js';

const msg = (id: string, role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role, content, createdAt: 0, ...extra,
});
const rows = (messages: ChatMessage[]) => toTranscriptRows(messages, extractPrUrls, collectSessionPrUrls);

describe('toTranscriptRows', () => {
  it('lays a turn out as message, steps, answer', () => {
    const r = rows([
      msg('u', 'user', 'fix it'),
      msg('a1', 'assistant', '', { toolCalls: [{ id: 'c', name: 'read_file', input: {} }] }),
      msg('t', 'tool', 'contents', { toolResult: { toolCallId: 'c', output: 'contents' } }),
      msg('a2', 'assistant', 'Fixed.'),
    ]);
    expect(r.map((x) => x.kind)).toEqual(['msg', 'activity', 'msg']);
    expect(new Set(r.map((x) => x.key)).size).toBe(r.length);
  });

  it('anchors discoveries including tool-only PRs instead of moving them after new messages', () => {
    const pr1 = 'https://github.com/o/r/pull/1';
    const pr2 = 'https://github.com/o/r/pull/2';
    const base = [msg('u', 'user', 'make PRs'), msg('a1', 'assistant', 'Opened ' + pr1, { toolCalls: [{ id: 'x', name: 'bash', input: { command: 'gh pr create' } }] }),
      msg('t', 'tool', '', { toolResult: { toolCallId: 'x', output: pr1 } }),
      msg('a-create2', 'assistant', '', { toolCalls: [{ id: 'y', name: 'bash', input: { command: 'gh pr create' } }] }),
      msg('t2', 'tool', '', { toolResult: { toolCallId: 'y', output: pr2 } })];
    const before = rows(base);
    const after = rows([...base, msg('u2', 'user', 'run the build'), msg('a2', 'assistant', 'Building.')]);
    expect(before.filter((r) => r.kind === 'prs').map((r) => r.urls)).toEqual([[pr1], [pr2]]);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toMatchObject({ kind: 'msg', message: { id: 'a2' } });
  });

  it('keeps created and merged milestones separate, before later replies', () => {
    const url = 'https://github.com/o/r/pull/1';
    const messages = [msg('a', 'assistant', '', { createdAt: 90, toolCalls: [{ id: 'create', name: 'bash', input: { command: 'gh pr create' } }] }), msg('t', 'tool', url, { createdAt: 100, toolResult: { toolCallId: 'create', output: url } }), msg('merged', 'assistant', 'Merged.', { createdAt: 200 }), msg('u', 'user', 'Next task', { createdAt: 400 })];
    const prs = [{ url, state: 'merged', mergedAt: new Date(250).toISOString() }] as any;
    const result = toTranscriptRows(messages, extractPrUrls, collectSessionPrUrls, prs);
    expect(result.map((r) => r.kind === 'prs' ? r.event : r.kind === 'msg' ? r.message.id : r.kind)).toEqual(['activity', 'created', 'merged', 'merged', 'u']);
    expect(new Set(result.map((r) => r.key)).size).toBe(result.length);
  });

  it('does not append phantom PR cards from reading test fixtures', () => {
    const r = rows([
      msg('a', 'assistant', '', { toolCalls: [{ id: 'read', name: 'read_file', input: {} }] }),
      msg('t', 'tool', '', { toolResult: { toolCallId: 'read', output: 'https://github.com/o/r/pull/1' } }),
      msg('done', 'assistant', 'Read the tests.'),
    ]);
    expect(r.map((x) => x.kind)).toEqual(['activity', 'msg']);
  });

  it('keeps keys stable as messages are appended', () => {
    const base = [msg('u', 'user', 'a'), msg('a', 'assistant', 'b')];
    const before = rows(base).map((x) => x.key);
    const after = rows([...base, msg('u2', 'user', 'c')]).map((x) => x.key);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('gives duplicate ids their own keys', () => {
    const r = rows([msg('tmp', 'user', 'a'), msg('tmp', 'user', 'b')]);
    expect(r[0].key).not.toBe(r[1].key);
  });

  it('skips an assistant message that would render nothing', () => {
    expect(rows([msg('u', 'user', 'hi'), msg('a', 'assistant', '')])).toHaveLength(1);
  });

  it('keeps an image-chat reply that is only a picture, and sizes it by its aspect', () => {
    const generated = { modelId: 'flux', width: 1024, height: 512, steps: 4, cfgScale: 1, seed: 7, ms: 4400 };
    const r = rows([msg('u', 'user', 'a cat'), msg('a', 'assistant', '', { images: ['data:image/png;base64,eA=='], generated })]);
    expect(r).toHaveLength(2);
    const tall = rows([msg('b', 'assistant', '', { images: ['x'], generated: { ...generated, height: 2048 } })])[0];
    expect(estimateRowHeight(tall, 800)).toBeGreaterThan(estimateRowHeight(r[1], 800));
  });
});

describe('estimateRowHeight', () => {
  it('grows with the text and shrinks with the width', () => {
    const [short] = rows([msg('a', 'assistant', 'one line')]);
    const [long] = rows([msg('b', 'assistant', 'word '.repeat(400))]);
    expect(estimateRowHeight(long, 600)).toBeGreaterThan(estimateRowHeight(short, 600));
    expect(estimateRowHeight(long, 400)).toBeGreaterThan(estimateRowHeight(long, 900));
  });
});

describe('message timestamps', () => {
  it('format exactly as the Date locale methods they replace', () => {
    for (const ts of [Date.UTC(2026, 0, 1, 9, 5), Date.UTC(2026, 8, 30, 23, 59, 58), 1]) {
      expect(fmtTime(ts)).toBe(new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      expect(fmtDateTime(ts)).toBe(new Date(ts).toLocaleString());
    }
    expect(fmtTime(0)).toBe('');
  });
});

describe('compaction rows', () => {
  const none = () => [];
  it('puts a divider row where the chat was compacted, after the turns it replaced', () => {
    const rows = toTranscriptRows([
      msg('u1', 'user', 'old'),
      msg('a1', 'assistant', 'old answer'),
      msg('c1', 'assistant', 'S1', { compaction: { summarized: 2 } }),
      msg('u2', 'user', 'new'),
      msg('c2', 'assistant', 'S2', { compaction: { summarized: 4 } }),
      msg('u3', 'user', 'newest'),
    ], none, none);
    expect(rows.map((r) => r.kind)).toEqual(['msg', 'msg', 'compaction', 'msg', 'compaction', 'msg']);
    const summaries = rows.filter((r) => r.kind === 'compaction');
    expect(summaries.map((r) => r.kind === 'compaction' && r.latest)).toEqual([false, true]);
    expect(estimateRowHeight(summaries[1], 600)).toBeGreaterThan(estimateRowHeight(summaries[0], 600));
  });
});
