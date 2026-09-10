import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Workflow } from '@agent-nekko/shared';
import { setDataDir } from './paths.js';
import { saveSettings } from './store.js';
import { createWorkflow, listWorkflowRuns } from './workflows.js';
import { tickListeners, startWorkflowListeners, stopWorkflowListeners, resetWorkflowListeners } from './listeners.js';

let dir = '';
let fetchMock: Mock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kotrain-listeners-'));
  setDataDir(dir);
  resetWorkflowListeners();
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  stopWorkflowListeners();
  vi.restoreAllMocks();
});

function mockSlackHistory(messages: any[]) {
  fetchMock.mockImplementation(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('conversations.list')) {
      return new Response(JSON.stringify({ ok: true, channels: [{ id: 'C123', name: 'builds' }] }), { status: 200 });
    }
    if (u.includes('conversations.history')) {
      return new Response(JSON.stringify({ ok: true, messages }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
}

function slackWorkflow(channel: string, filter?: string): Workflow {
  return createWorkflow({
    name: 'Slack watcher',
    steps: [{ id: 's1', name: 'Echo', kind: 'shell', run: 'echo ok' }],
    triggers: [
      {
        id: 'trg-slack',
        kind: 'connector',
        connector: 'slack',
        event: 'message',
        channel,
        filter,
        pollIntervalMs: 0,
      },
    ],
  });
}

function connectSlack() {
  saveSettings({ connectors: [{ kind: 'slack', connected: true, token: 'xoxb-test', connectedAt: Date.now() }] });
}

describe('connector listeners', () => {
  it('advances the cursor and dispatches new events', async () => {
    connectSlack();
    slackWorkflow('C123');
    const ts = String((Date.now() + 1000) / 1000);
    mockSlackHistory([{ ts, text: 'deploy', user: 'U1' }]);

    await tickListeners();

    const runs = listWorkflowRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerKind).toBe('connector');
    expect(runs[0].triggerLabel).toContain('deploy');
  });

  it('deduplicates events by id within a session', async () => {
    connectSlack();
    slackWorkflow('C123');
    const ts = String((Date.now() + 1000) / 1000);
    mockSlackHistory([{ ts, text: 'deploy', user: 'U1' }]);

    await tickListeners();
    await tickListeners();

    expect(listWorkflowRuns()).toHaveLength(1);
  });

  it('filters events by substring', async () => {
    connectSlack();
    slackWorkflow('C123', 'ship');
    const now = (Date.now() + 1000) / 1000;
    mockSlackHistory([
      { ts: String(now), text: 'deploy', user: 'U1' },
      { ts: String(now + 1), text: 'ship it', user: 'U2' },
    ]);

    await tickListeners();

    const runs = listWorkflowRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].triggerLabel).toContain('ship it');
  });

  it('skips unconnected connectors', async () => {
    slackWorkflow('C123');
    const ts = String((Date.now() + 1000) / 1000);
    mockSlackHistory([{ ts, text: 'deploy', user: 'U1' }]);

    await tickListeners();

    expect(listWorkflowRuns()).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts and stops the global scheduler without crashing', () => {
    expect(() => startWorkflowListeners()).not.toThrow();
    expect(() => stopWorkflowListeners()).not.toThrow();
  });
});
