import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agent-nekko/shared';
import { collectSessionPrUrls, extractPrUrls } from '@agent-nekko/shared';
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

  it('puts a PR card after the message that first names it, and the rest at the end', () => {
    const pr1 = 'https://github.com/o/r/pull/1';
    const pr2 = 'https://github.com/o/r/pull/2';
    const r = rows([
      msg('u', 'user', `look at ${pr1}`),
      msg('a1', 'assistant', `Opened ${pr1}`),
      msg('a2', 'assistant', `Still ${pr1}`),
      msg('t', 'tool', '', { toolResult: { toolCallId: 'x', output: `created ${pr2}` } }),
    ]);
    expect(r.map((x) => (x.kind === 'msg' ? x.prUrls : x.kind === 'prs' ? x.urls : []))).toEqual([[], [pr1], [], [pr2]]);
    expect(r[1].gapAfter).toBe(8);
    expect(r[3]).toMatchObject({ kind: 'prs', gapAfter: 8 });
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
