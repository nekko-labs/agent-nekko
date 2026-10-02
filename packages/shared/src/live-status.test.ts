import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './chat.js';
import { emptyLiveActivity, reduceLiveActivity, shortLiveStatus } from './live-activity.js';

const T = 1_700_000_000_000;

/** Fold a list of events the way the renderer does, for readable tests. */
function fold(events: AgentEvent[]) {
  let a = emptyLiveActivity(T);
  for (const e of events) a = reduceLiveActivity(a, e, T)!;
  return a;
}

const call = (name: string, input: Record<string, unknown>): AgentEvent => ({
  type: 'tool_call',
  sessionId: 's',
  call: { id: `c_${name}`, name, input },
});

const result = (name: string, output = 'ok', isError = false): AgentEvent => ({
  type: 'tool_result',
  sessionId: 's',
  result: { toolCallId: `c_${name}`, output, isError },
});

describe('shortLiveStatus', () => {
  it('says what the running tool is doing, in words rather than in its name', () => {
    // "read_file" under a spinner is jargon; the point of the line is that a
    // glance tells you where the time is going.
    const a = fold([call('read_file', { path: 'src/renderer/components/ChatPane.tsx' })]);
    expect(shortLiveStatus(a)).toBe('Reading ChatPane.tsx');
  });

  it('shortens a path to its leaf, because the route is not the news', () => {
    const a = fold([call('edit_file', { path: 'a/very/deep/nested/dir/store.ts' })]);
    expect(shortLiveStatus(a)).toBe('Editing store.ts');
  });

  it('keeps a shell command as written rather than cutting it at a slash', () => {
    const a = fold([call('bash', { command: 'npm run build' })]);
    expect(shortLiveStatus(a)).toBe('Running npm');
  });

  it('stays within its word budget so the line never reflows', () => {
    const a = fold([call('grep', { pattern: 'one two three four five six seven eight' })]);
    expect(shortLiveStatus(a).split(/\s+/).length).toBeLessThanOrEqual(5);
  });

  it('falls back to an unknown tool\'s own name instead of a generic word', () => {
    // An MCP tool is not in the verb table, and its name still beats "Working".
    const a = fold([call('linear_create_issue', { title: 'Fix the importer' })]);
    expect(shortLiveStatus(a)).toContain('linear_create_issue');
  });

  it('reports thinking while the model reasons', () => {
    const a = fold([{ type: 'reasoning', sessionId: 's', delta: 'Let me consider the options here.' }]);
    expect(shortLiveStatus(a)).toBe('Thinking');
  });

  it('reports writing once the answer starts coming out', () => {
    const a = fold([{ type: 'text', sessionId: 's', delta: 'Here is what I found in the parser.' }]);
    expect(shortLiveStatus(a)).toBe('Writing reply');
  });

  it('reports the next reasoning phase between tools rather than a completed action', () => {
    // A gap between a result and the next call used to leave the line empty,
    // which reads as the run having stopped.
    const a = fold([call('grep', { pattern: 'foo' }), result('grep')]);
    expect(shortLiveStatus(a)).toBe('Thinking');
  });

  it('keeps the live label in present tense while recovering from a tool error', () => {
    const a = fold([call('bash', { command: 'npm test' }), result('bash', 'boom', true)]);
    expect(shortLiveStatus(a)).toBe('Thinking');
  });

  it('prefers the running tool over the thought that preceded it', () => {
    // Both are true at once; the tool is where the seconds are actually going.
    const a = fold([
      { type: 'reasoning', sessionId: 's', delta: 'I should look at the config file.' },
      call('read_file', { path: 'vite.config.ts' }),
    ]);
    expect(shortLiveStatus(a)).toBe('Reading vite.config.ts');
  });

  it('is empty for a session with nothing in flight', () => {
    expect(shortLiveStatus(undefined)).toBe('');
  });

  it('says Starting before the first step lands', () => {
    expect(shortLiveStatus(emptyLiveActivity(T))).toBe('Starting');
  });

  it('reports an image turn by its stage, never as writing a reply', () => {
    const a = fold([
      { type: 'image_status', sessionId: 's', stage: 'loading', label: 'Loading the image model' },
      { type: 'image_status', sessionId: 's', stage: 'generating', label: 'Generating a 1024×1024 image' },
    ]);
    expect(a?.tail).toBe('');
    expect(shortLiveStatus(a)).toBe('Generating a 1024×1024 image');
  });
});
