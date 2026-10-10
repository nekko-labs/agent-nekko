import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agent-nekko/shared';
import { LOOP_ERROR_STREAK, LOOP_REPEATS, LOOP_WINDOW, createLoopDetector } from './progress.js';
import { runAgent } from './loop.js';
import type { ChatRequest, Provider, ProviderChunk } from '../providers/types.js';

const call = (name: string, input: unknown, id = 'c') => ({ id, name, input: input as Record<string, unknown> });
const ok = (output: string) => ({ toolCallId: 'c', output });
const err = (output: string) => ({ toolCallId: 'c', output, isError: true });

describe('createLoopDetector', () => {
  it('stays quiet on varied, productive work', () => {
    const d = createLoopDetector();
    for (let i = 0; i < 50; i++) expect(d.push(call('read_file', { path: `f${i}.ts` }), ok(`body ${i}`))).toBeUndefined();
  });

  it('trips on the same call returning the same result', () => {
    const d = createLoopDetector();
    for (let i = 1; i < LOOP_REPEATS; i++) expect(d.push(call('bash', { command: 'npm test' }), ok('1 failing'))).toBeUndefined();
    expect(d.push(call('bash', { command: 'npm test' }), ok('1 failing'))).toMatch(/bash with the same input/);
  });

  it('does not count a re-run whose result changed (that is progress)', () => {
    const d = createLoopDetector();
    for (let i = 0; i < 10; i++) expect(d.push(call('bash', { command: 'npm test' }), ok(`${10 - i} failing`))).toBeUndefined();
  });

  it('catches an A-B-A-B cycle', () => {
    const d = createLoopDetector();
    const seq = [
      () => d.push(call('read_file', { path: 'a' }), ok('A')),
      () => d.push(call('edit_file', { path: 'a' }), err('no match')),
    ];
    const out: (string | undefined)[] = [];
    for (let i = 0; i < LOOP_REPEATS * 2; i++) out.push(seq[i % 2]());
    expect(out.slice(0, -2).every((r) => r === undefined)).toBe(true);
    expect(out.at(-2)).toMatch(/read_file/);
  });

  it('forgets repeats that fell out of the window', () => {
    const d = createLoopDetector();
    d.push(call('bash', { command: 'ls' }), ok('x'));
    for (let i = 0; i < LOOP_WINDOW; i++) d.push(call('read_file', { path: `f${i}` }), ok(String(i)));
    d.push(call('bash', { command: 'ls' }), ok('x'));
    expect(d.push(call('read_file', { path: 'z' }), ok('z'))).toBeUndefined();
  });

  it('trips on one tool failing repeatedly with different inputs', () => {
    const d = createLoopDetector();
    for (let i = 1; i < LOOP_ERROR_STREAK; i++) expect(d.push(call('bash', { command: `try ${i}` }), err(`e${i}`))).toBeUndefined();
    expect(d.push(call('bash', { command: 'try last' }), err('e'))).toMatch(/bash failing 5 times in a row/);
  });

  it('a success breaks the error streak', () => {
    const d = createLoopDetector();
    for (let i = 0; i < 20; i++) {
      expect(d.push(call('bash', { command: `c${i}` }), i % 4 === 3 ? ok(`ok${i}`) : err(`e${i}`))).toBeUndefined();
    }
  });
});

/** A model that calls the same failing command forever while it has tools. */
function stuckProvider(seen: ChatRequest[]): Provider {
  return {
    config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
    listModels: async () => [],
    test: async () => ({ ok: true, message: '' }),
    async *chat(req: ChatRequest) {
      seen.push(req);
      if (req.tools?.length) yield { type: 'tool_call', call: { id: `c${seen.length}`, name: 'bash', input: { command: 'gh pr list' } } } as ProviderChunk;
      else yield { type: 'text', delta: 'gh is not authenticated' } as ProviderChunk;
      yield { type: 'done' } as ProviderChunk;
    },
  };
}

describe('runAgent loop detection', () => {
  it('nudges once, then stops early with an honest note instead of looping forever', async () => {
    const seen: ChatRequest[] = [];
    const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'list PRs', createdAt: 0 }];
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider: stuckProvider(seen), model: 'm', system: 'sys', history,
      executeTool: async (c) => ({ toolCallId: c.id, output: 'HTTP 401', isError: true }),
    })) events.push(e);

    // 3 repeats → nudge, 3 more → wrap up: 6 tool rounds and one wrap-up.
    expect(seen).toHaveLength(LOOP_REPEATS * 2 + 1);
    expect(seen[LOOP_REPEATS].messages.at(-1)?.content).toMatch(/stuck in a loop/);
    expect(seen.at(-1)?.tools).toEqual([]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: 'done', stop: 'loop', steps: LOOP_REPEATS * 2 });
    expect(history.at(-1)?.content).toContain('gh is not authenticated');
    expect(history.at(-1)?.content).toContain('Stopped early');
    // The nudges are never persisted.
    expect(history.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('reports steps and a complete stop on a normal reply', async () => {
    let n = 0;
    const provider: Provider = {
      config: { id: 'p', kind: 'openai-compat', label: 'x', baseUrl: 'x', enabled: true },
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        n++;
        if (n <= 2) yield { type: 'tool_call', call: { id: `c${n}`, name: 'read_file', input: { path: `f${n}` } } } as ProviderChunk;
        else yield { type: 'text', delta: 'done' } as ProviderChunk;
        yield { type: 'done' } as ProviderChunk;
      },
    };
    const events = [];
    for await (const e of runAgent({
      sessionId: 's', provider, model: 'm', system: 'sys', history: [{ id: 'u', role: 'user', content: 'go', createdAt: 0 }],
      executeTool: async (c) => ({ toolCallId: c.id, output: c.id }),
    })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'done', stop: 'complete', steps: 2 });
  });
});
