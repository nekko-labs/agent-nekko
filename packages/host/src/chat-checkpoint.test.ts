import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ProviderConfig, Session } from '@agent-nekko/shared';
import type { Provider, ProviderChunk } from '@agent-nekko/core';

/**
 * A long agent run has to survive being cut off. These exercise the two halves
 * of that: the host writes each completed step to disk as it lands (so a run
 * killed mid-flight leaves its work behind), and resuming continues from that
 * transcript instead of re-running everything.
 *
 * The provider is scripted, so a "timeout" is just a throw, and no model is
 * needed to reproduce the failure the fix is about.
 */

/** Rounds of chunks the fake model returns, one per call; a thrown round breaks the stream. */
let rounds: Array<ProviderChunk[] | Error> = [];
let round = 0;

vi.mock('@agent-nekko/core', async () => {
  const actual = await vi.importActual<typeof import('@agent-nekko/core')>('@agent-nekko/core');
  return {
    ...actual,
    createProvider: (config: ProviderConfig): Provider => ({
      config,
      listModels: async () => [],
      test: async () => ({ ok: true, message: '' }),
      async *chat() {
        const step = rounds[round++] ?? [{ type: 'done' as const }];
        if (step instanceof Error) throw step;
        for (const c of step) yield c;
      },
    }),
  };
});

const { setDataDir } = await import('./paths.js');
const { saveSettings } = await import('./store.js');
const { createSession, getSession } = await import('./sessions.js');
const { sendChat } = await import('./chat.js');

let dir: string;
let workspace: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kotrain-checkpoint-'));
  workspace = mkdtempSync(join(tmpdir(), 'kotrain-ws-'));
  setDataDir(dir);
  saveSettings({
    workspaces: [{ id: 'w1', name: 'ws', path: workspace, addedAt: 0 }],
    providers: [{ id: 'p1', kind: 'openai-compat', label: 'Test', baseUrl: 'http://localhost:1/v1', enabled: true }],
    defaultChatMode: 'yolo', // no approval prompts in a headless test
  });
  rounds = [];
  round = 0;
});

/** The expensive tool result whose loss is the whole complaint. */
const EXPENSIVE = 'the result that took forty minutes';

function readTool(path: string): ProviderChunk {
  return { type: 'tool_call', call: { id: 'c1', name: 'read_file', input: { path } } };
}

async function run(session: Session, opts: { resume?: boolean } = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await sendChat(
    { sessionId: session.id, providerId: 'p1', modelId: 'm', text: opts.resume ? '' : 'do the long thing', ...opts },
    (e) => events.push(e),
  );
  return events;
}

describe('a run that is cut off part-way', () => {
  it('has already written its finished steps to disk when it breaks', async () => {
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], new Error('terminated')];

    const session = createSession('w1');
    let onDiskMidRun: Session | null = null;
    await sendChat({ sessionId: session.id, providerId: 'p1', modelId: 'm', text: 'read it' }, (e) => {
      // The moment the tool answers, before the run goes on to break: the step
      // must already be on disk, not only in memory.
      if (e.type === 'tool_result') onDiskMidRun = getSession(session.id);
    });

    expect(onDiskMidRun).not.toBeNull();
    expect(onDiskMidRun!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(onDiskMidRun!.messages[2].toolResult?.output).toContain(EXPENSIVE);
  });

  it('keeps the finished steps and the cut-off reply after it fails', async () => {
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], new Error('terminated')];

    const session = createSession('w1');
    const events = await run(session);

    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'terminated' });
    const saved = getSession(session.id)!;
    expect(saved.messages.some((m) => m.toolResult?.output.includes(EXPENSIVE))).toBe(true);
  });
});

describe('resuming a cut-off run', () => {
  it('carries on without running the finished tool again', async () => {
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], new Error('terminated')];

    const session = createSession('w1');
    await run(session);
    const afterFailure = getSession(session.id)!;
    const toolResultsBefore = afterFailure.messages.filter((m) => m.role === 'tool').length;

    // Resume: the model answers straight away, calling nothing.
    round = 0;
    rounds = [[{ type: 'text', delta: 'Finishing up from where I stopped.' }, { type: 'done' }]];
    await run(afterFailure, { resume: true });

    const resumed = getSession(session.id)!;
    // The prompt was not asked again and the tool was not re-run.
    expect(resumed.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(resumed.messages.filter((m) => m.role === 'tool')).toHaveLength(toolResultsBefore);
    expect(resumed.messages.some((m) => m.toolResult?.output.includes(EXPENSIVE))).toBe(true);
    expect(resumed.messages.at(-1)?.content).toBe('Finishing up from where I stopped.');
  });

  it('starting over instead would have thrown the work away', async () => {
    // The old Retry path: truncate back to the last user message and re-send.
    // Kept as a contrast, so the difference the fix makes is spelled out.
    const file = join(workspace, 'notes.txt');
    writeFileSync(file, EXPENSIVE, 'utf8');
    rounds = [[readTool(file), { type: 'done' }], new Error('terminated')];

    const session = createSession('w1');
    await run(session);

    const { truncateSession } = await import('./sessions.js');
    const lastUser = getSession(session.id)!.messages.find((m) => m.role === 'user')!;
    const truncated = truncateSession(session.id, lastUser.id)!;
    expect(truncated.messages.some((m) => m.toolResult?.output.includes(EXPENSIVE))).toBe(false);
  });
});
