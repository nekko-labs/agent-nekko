import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { WORKFLOW_ACTIONS } from '@agent-nekko/shared';
import type { ConnectorConfig, WorkflowEvent } from '@agent-nekko/shared';
import {
  getWorkflowAction,
  renderTemplate,
  runWorkflowAction,
  templateContext,
} from './actions.js';
import { gitlabBase } from './index.js';

const cfg = (kind: string, token = 'tok', settings?: Record<string, string>): ConnectorConfig =>
  ({ kind: kind as ConnectorConfig['kind'], connected: true, token, settings });

const gitEvent = (payload: Record<string, unknown>): WorkflowEvent => ({
  kind: 'git',
  provider: 'github',
  event: 'push',
  repo: 'acme/app',
  branch: 'main',
  payload,
});

const runInfo = { id: 'r1', workflowId: 'w1', workflowName: 'Nightly CI', status: 'running' };

describe('renderTemplate', () => {
  const ctx = templateContext({
    event: gitEvent({ sha: 'abc123', pull_number: 12 }),
    outputs: new Map([['build', 'tests passed']]),
    run: runInfo,
  });

  it('interpolates trigger fields, including payload keys', () => {
    expect(renderTemplate('on {{trigger.branch}} at {{trigger.sha}}', ctx)).toBe('on main at abc123');
    expect(renderTemplate('{{trigger.pull_number}}', ctx)).toBe('12');
  });

  it('interpolates step outputs and run fields', () => {
    expect(renderTemplate('{{steps.build.output}} → {{run.status}} / {{run.workflowName}}', ctx)).toBe(
      'tests passed → running / Nightly CI',
    );
  });

  it('resolves a missing leaf to an empty string', () => {
    expect(renderTemplate('x{{trigger.nope}}y', ctx)).toBe('xy');
    expect(renderTemplate('x{{steps.gone.output}}y', ctx)).toBe('xy');
  });

  it('leaves unknown roots and bare roots alone', () => {
    expect(renderTemplate('{{foo.bar}} and {{trigger}}', ctx)).toBe('{{foo.bar}} and {{trigger}}');
  });

  it('stringifies non-string values', () => {
    const c = templateContext({ event: gitEvent({ labels: ['a', 'b'] }), run: runInfo });
    expect(renderTemplate('{{trigger.labels}}', c)).toBe('["a","b"]');
  });

  it('passes plain text through untouched', () => {
    expect(renderTemplate('nothing to do', ctx)).toBe('nothing to do');
  });
});

describe('action registry', () => {
  it('has a runner for every catalog op', () => {
    for (const a of WORKFLOW_ACTIONS) {
      expect(getWorkflowAction(a.op), a.op).toBeDefined();
      expect(getWorkflowAction(a.op)?.label).toBe(a.label);
    }
  });

  it('reports an unknown op as an error result', async () => {
    const res = await runWorkflowAction('slack.teleport', cfg('slack'), {}, {});
    expect(res.isError).toBe(true);
    expect(res.output).toContain('Unknown action');
  });
});

describe('action runners', () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
  });

  it('slack.postMessage posts to chat.postMessage with the bot token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1.2' }), { status: 200 }));
    const res = await runWorkflowAction(
      'slack.postMessage',
      cfg('slack'),
      { channel: '#builds', text: 'hi {{run.status}}' },
      {},
    );
    expect(res.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://slack.com/api/chat.postMessage');
    expect((init as any).headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse((init as any).body as string);
    expect(body).toEqual({ channel: 'builds', text: 'hi {{run.status}}' });
  });

  it('slack.postMessage surfaces an API-level failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }));
    const res = await runWorkflowAction('slack.postMessage', cfg('slack'), { channel: 'x', text: 't' }, {});
    expect(res.isError).toBe(true);
    expect(res.output).toContain('channel_not_found');
  });

  it('github.setCommitStatus falls back to the event payload for repo and sha', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const res = await runWorkflowAction(
      'github.setCommitStatus',
      cfg('github'),
      { state: 'failed' },
      { event: gitEvent({ after: 'deadbeef' }), run: runInfo },
    );
    expect(res.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    // Event repo and `after` sha, GitLab's "failed" spelling normalized, and a
    // default context built from the workflow name.
    expect(String(url)).toBe('https://api.github.com/repos/acme/app/statuses/deadbeef');
    const body = JSON.parse((init as any).body as string);
    expect(body.state).toBe('failure');
    expect(body.context).toBe('agent-nekko/nightly-ci');
  });

  it('github.setCommitStatus reads repo/sha out of a raw push webhook body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const res = await runWorkflowAction(
      'github.setCommitStatus',
      cfg('github'),
      { state: 'success' },
      {
        event: { kind: 'webhook', slug: 'ci', payload: { after: 'cafe01', repository: { full_name: 'acme/app' } } },
        run: runInfo,
      },
    );
    expect(res.isError).toBeUndefined();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.github.com/repos/acme/app/statuses/cafe01');
  });

  it('github.setCommitStatus reads the head sha out of a raw pull_request body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const res = await runWorkflowAction(
      'github.setCommitStatus',
      cfg('github'),
      { state: 'pending' },
      {
        event: {
          kind: 'webhook',
          slug: 'ci',
          payload: { repository: { full_name: 'acme/app' }, pull_request: { head: { sha: 'pr9sha' } } },
        },
        run: runInfo,
      },
    );
    expect(res.isError).toBeUndefined();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.github.com/repos/acme/app/statuses/pr9sha');
  });

  it('github.commentPR resolves repo and number from a raw pull_request body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const res = await runWorkflowAction(
      'github.commentPR',
      cfg('github'),
      { body: 'build failed' },
      {
        event: {
          kind: 'webhook',
          slug: 'ci',
          payload: { repository: { full_name: 'acme/app' }, pull_request: { number: 9 } },
        },
        run: runInfo,
      },
    );
    expect(res.isError).toBeUndefined();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.github.com/repos/acme/app/issues/9/comments');
  });

  it('gitlab.commentMR resolves project and iid from a raw merge_request body', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const res = await runWorkflowAction(
      'gitlab.commentMR',
      cfg('gitlab', 'glpat'),
      { body: 'pipeline failed' },
      {
        event: {
          kind: 'webhook',
          slug: 'ci',
          payload: { project: { path_with_namespace: 'grp/app' }, object_attributes: { iid: 4 } },
        },
        run: runInfo,
      },
    );
    expect(res.isError).toBeUndefined();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://gitlab.com/api/v4/projects/grp%2Fapp/merge_requests/4/notes');
  });

  it('gitlab.setCommitStatus resolves project_id and the MR head commit', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await runWorkflowAction(
      'gitlab.setCommitStatus',
      cfg('gitlab', 'glpat'),
      { state: 'failed' },
      {
        event: {
          kind: 'webhook',
          slug: 'ci',
          payload: { project_id: 42, object_attributes: { last_commit: { id: 'glsha' } } },
        },
        run: runInfo,
      },
    );
    expect(res.isError).toBeUndefined();
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v4/projects/42/statuses/glsha');
  });

  it('github.setCommitStatus rejects a bad state without fetching', async () => {
    const res = await runWorkflowAction('github.setCommitStatus', cfg('github'), { repo: 'a/b', sha: 'x', state: 'bogus' }, {});
    expect(res.isError).toBe(true);
    expect(res.output).toContain('bogus');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('github.commentPR requires a token from the connector config', async () => {
    const res = await runWorkflowAction(
      'github.commentPR',
      { kind: 'github', connected: true },
      { repo: 'a/b', number: '3', body: 'hi' },
      {},
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain('token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gitlab.setCommitStatus uses the instance URL and maps failure to failed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const res = await runWorkflowAction(
      'gitlab.setCommitStatus',
      cfg('gitlab', 'glpat', { site: 'https://gitlab.internal.example.com/' }),
      { project: 'grp/app', sha: 'cafe', state: 'failure', name: 'ci' },
      {},
    );
    expect(res.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('https://gitlab.internal.example.com/api/v4/projects/grp%2Fapp/statuses/cafe');
    expect(String(url)).toContain('state=failed');
    expect((init as any).headers['PRIVATE-TOKEN']).toBe('glpat');
  });

  it('jira.commentIssue posts an ADF comment with Basic auth', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 201 }));
    const res = await runWorkflowAction(
      'jira.commentIssue',
      cfg('jira', 'api-tok', { site: 'https://team.atlassian.net/', email: 'me@co.com' }),
      { issue: 'ENG-12', body: 'looks good' },
      {},
    );
    expect(res.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://team.atlassian.net/rest/api/3/issue/ENG-12/comment');
    expect((init as any).headers.Authorization).toBe(`Basic ${Buffer.from('me@co.com:api-tok').toString('base64')}`);
    const body = JSON.parse((init as any).body as string);
    expect(body.body.content[0].content[0].text).toBe('looks good');
  });

  it('teams.postMessage refuses a non-Teams webhook host', async () => {
    const res = await runWorkflowAction(
      'teams.postMessage',
      cfg('teams', '', { webhookUrl: 'https://evil.example.com/hook' }),
      { text: 'hi' },
      {},
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain('webhook.office.com');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('teams.postMessage posts text to the saved webhook', async () => {
    fetchMock.mockResolvedValueOnce(new Response('1', { status: 200 }));
    const res = await runWorkflowAction(
      'teams.postMessage',
      cfg('teams', '', { webhookUrl: 'https://acme.webhook.office.com/abc' }),
      { text: 'deploy done' },
      {},
    );
    expect(res.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://acme.webhook.office.com/abc');
    expect(JSON.parse((init as any).body as string)).toEqual({ text: 'deploy done' });
  });

  it('webhook.post only sends to https URLs', async () => {
    for (const url of ['http://example.com/h', 'file:///etc/passwd', 'not a url']) {
      const res = await runWorkflowAction('webhook.post', undefined, { url, body: '{}' }, {});
      expect(res.isError, url).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('webhook.post sends the body with the configured content type', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await runWorkflowAction(
      'webhook.post',
      undefined,
      { url: 'https://hooks.example.com/x', body: '{"a":1}', contentType: 'application/vnd.custom+json' },
      {},
    );
    expect(res.isError).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://hooks.example.com/x');
    expect((init as any).method).toBe('POST');
    expect((init as any).headers['Content-Type']).toBe('application/vnd.custom+json');
    expect((init as any).body).toBe('{"a":1}');
    expect((init as any).redirect).toBe('manual');
  });

  it('gitlabBase defaults to gitlab.com and requires https', () => {
    expect(gitlabBase({})).toBe('https://gitlab.com');
    expect(gitlabBase({ site: 'https://gl.internal/' })).toBe('https://gl.internal');
    expect(() => gitlabBase({ site: 'http://gl.internal' })).toThrow('https');
  });
});
