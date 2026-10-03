import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ChatMessage, ToolCall } from '@agent-nekko/shared';
import { loopApprove, loopEnd, loopEvent, loopTool, runAgentViaDaemon } from './daemon-loop.js';

/**
 * A scripted daemon: `loop:run` answers at once, then the "run" calls back the
 * way crates/nekkod/src/loops.rs does (deltas, a tool call, a checkpoint, a
 * final event it waits on, then the end).
 */
function scriptedDaemon(order: string[]) {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const call = vi.fn(async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    if (channel !== 'loop:run') return true as never;
    const spec = args[0] as { runId: string; history: ChatMessage[] };
    const { runId } = spec;
    setTimeout(async () => {
      await loopEvent(runId, { events: [{ type: 'text', sessionId: 's', delta: 'Let me look. ' } as AgentEvent] });
      const result = await loopTool(runId, { id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
      const afterTool: ChatMessage[] = [
        ...spec.history,
        { id: 'm1', role: 'assistant', content: 'Let me look. ', toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }], createdAt: 2 },
        { id: 'm2', role: 'tool', content: '', toolResult: result, createdAt: 3 },
      ];
      await loopEvent(runId, { events: [{ type: 'tool_result', sessionId: 's', result } as AgentEvent], history: afterTool });
      const final = [...afterTool, { id: 'm3', role: 'assistant', content: 'Done.', createdAt: 4 } as ChatMessage];
      await loopEvent(runId, { events: [{ type: 'done', sessionId: 's', messageId: 'm3' } as AgentEvent], history: final });
      order.push('daemon saw done acknowledged');
      loopEnd(runId, { history: final });
    }, 5);
    return { started: true } as never;
  });
  return { call, calls };
}

describe('runAgentViaDaemon', () => {
  it('yields the daemon run as runAgent would, runs tools here, and acknowledges done only once it is handled', async () => {
    const order: string[] = [];
    const { call, calls } = scriptedDaemon(order);
    const history: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'read a.ts', createdAt: 1 }];
    const executeTool = vi.fn(async (c: ToolCall) => ({ toolCallId: c.id, output: 'export const a = 1;' }));
    const seen: Array<AgentEvent & { relayOnly?: boolean }> = [];
    for await (const e of runAgentViaDaemon(call as never, {
      sessionId: 's', provider: { id: 'p', kind: 'llamacpp', label: 'P', baseUrl: 'http://x', enabled: true } as never,
      model: 'm', system: 'SYS', history, tools: [], executeTool,
    })) {
      seen.push(e as AgentEvent & { relayOnly?: boolean });
      if (e.type === 'done') {
        // The consumer saves here, before the daemon may tell the UI.
        await new Promise((r) => setTimeout(r, 20));
        order.push('consumer handled done');
      }
    }
    expect(seen.map((e) => e.type)).toEqual(['text', 'tool_result', 'done']);
    expect(seen.every((e) => e.relayOnly === true)).toBe(true);
    expect(executeTool).toHaveBeenCalledWith({ id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
    expect(history.map((m) => m.id)).toEqual(['u1', 'm1', 'm2', 'm3']);
    expect(order).toEqual(['consumer handled done', 'daemon saw done acknowledged']);
    expect(calls[0]).toMatchObject({ channel: 'loop:run', args: [{ sessionId: 's', model: 'm', system: 'SYS' }] });
  });

  it('asks the daemon to stop when the turn is aborted, and ends cleanly', async () => {
    let runId = '';
    const call = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'loop:run') runId = (args[0] as { runId: string }).runId;
      if (channel === 'loop:abort') {
        setTimeout(() => {
          void loopEvent(String(args[0]), { events: [{ type: 'error', sessionId: 's', message: 'Stopped' } as AgentEvent] }).then(() => loopEnd(String(args[0]), {}));
        }, 1);
      }
      return true as never;
    });
    const controller = new AbortController();
    const seen: AgentEvent[] = [];
    setTimeout(() => controller.abort(), 10);
    for await (const e of runAgentViaDaemon(call as never, {
      sessionId: 's', provider: {} as never, model: 'm', system: '', history: [], tools: [],
      executeTool: async () => ({ toolCallId: '', output: '' }), signal: controller.signal,
    })) seen.push(e);
    expect(call.mock.calls.map((c) => c[0])).toEqual(['loop:run', 'loop:abort']);
    expect(seen).toMatchObject([{ type: 'error', message: 'Stopped' }]);
    expect(runId).toMatch(/^run_/);
    // A late tool call for an ended run is refused, not run.
    expect(await loopTool(runId, { id: 'c9', name: 'x', input: {} })).toMatchObject({ isError: true });
  });

  it('hands the daemon the tool context and answers its approval requests with the chat prompt', async () => {
    let spec: { runId: string; toolContext?: unknown } | undefined;
    const approvals: string[] = [];
    const call = vi.fn(async (channel: string, ...args: unknown[]) => {
      if (channel === 'loop:run') {
        spec = args[0] as typeof spec;
        setTimeout(async () => {
          const ok = await loopApprove(spec!.runId, { id: 'c1', name: 'bash', input: { command: 'rm x' } }, 'Run rm x', 'high');
          await loopEvent(spec!.runId, { events: [{ type: 'text', sessionId: 's', delta: String(ok) } as AgentEvent] });
          loopEnd(spec!.runId, {});
        }, 1);
      }
      return true as never;
    });
    const toolContext = { native: ['bash'], sessionId: 's', mode: 'ask', workspaces: [{ id: 'w', path: '/w' }], defaultCwd: '/w' };
    const seen: AgentEvent[] = [];
    for await (const e of runAgentViaDaemon(call as never, {
      sessionId: 's', provider: {} as never, model: 'm', system: '', history: [], tools: [],
      executeTool: async () => ({ toolCallId: '', output: '' }),
      requestApproval: async (c, reason, severity) => { approvals.push(`${c.name}: ${reason} (${severity})`); return true; },
      toolContext,
    })) seen.push(e);
    expect(spec?.toolContext).toEqual(toolContext);
    expect(approvals).toEqual(['bash: Run rm x (high)']);
    expect(seen).toMatchObject([{ type: 'text', delta: 'true' }]);
    // A run that has ended approves nothing.
    expect(await loopApprove(spec!.runId, { id: 'c2', name: 'bash', input: {} }, 'x', 'low')).toBe(false);
  });
});

describe('daemonRunsLoops', () => {
  // daemonOwns caches daemon:info per module, so each case loads a fresh copy.
  async function owns(owned: string[] | Error) {
    vi.resetModules();
    const mod = await import('./daemon-loop.js');
    const call = vi.fn(async () => {
      if (owned instanceof Error) throw owned;
      return { owned } as never;
    });
    return mod.daemonRunsLoops(call as never);
  }

  it('hands runs only to a daemon that runs with no tool-step limit', async () => {
    expect(await owns(['loop:run', 'loop:unbounded'])).toBe(true);
  });

  it('keeps the run in process for a daemon that predates the removed step limit', async () => {
    // Such a daemon read the host's budget literally, and once ran zero steps.
    expect(await owns(['loop:run'])).toBe(false);
    expect(await owns([])).toBe(false);
    expect(await owns(new Error('no daemon'))).toBe(false);
  });
});

describe('loop:run payload', () => {
  it('carries no step budget', async () => {
    const { call, calls } = scriptedDaemon([]);
    for await (const _ of runAgentViaDaemon(call as never, {
      sessionId: 's', provider: { id: 'p', kind: 'llamacpp', label: 'P', baseUrl: 'http://x', enabled: true } as never,
      model: 'm', system: 'SYS', history: [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }], tools: [],
      executeTool: async (c: ToolCall) => ({ toolCallId: c.id, output: '' }),
    })) { /* drain */ }
    const spec = calls.find((c) => c.channel === 'loop:run')!.args[0] as Record<string, unknown>;
    expect(Object.keys(spec).some((k) => /iteration|step/i.test(k))).toBe(false);
  });
});
