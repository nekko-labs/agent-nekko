import { describe, expect, it } from 'vitest';
import { readDaemonResponse } from './daemon-response.js';

describe('daemon response diagnostics', () => {
  it('reports plain-text failures without a JSON syntax error or raw body', async () => {
    await expect(readDaemonResponse(new Response('Failed to connect: secret-token', { status: 502 }), 'loop:start'))
      .rejects.toThrow('loop:start: HTTP 502 returned a non-JSON error response');
  });
  it('retains JSON API errors with channel and status', async () => {
    await expect(readDaemonResponse(new Response('{"error":"Service unavailable"}', { status: 503 }), 'loop:start'))
      .rejects.toThrow('loop:start: HTTP 503: Service unavailable');
  });
  it('returns successful JSON unchanged', async () => {
    await expect(readDaemonResponse(new Response('{"runId":"r1"}'), 'loop:start')).resolves.toEqual({ runId: 'r1' });
  });
  it('identifies malformed success responses', async () => {
    await expect(readDaemonResponse(new Response('Failed to connect'), 'loop:start')).rejects.toThrow('HTTP 200 returned invalid JSON');
  });
  it('supports empty success responses', async () => {
    await expect(readDaemonResponse(new Response(null, { status: 204 }), 'loop:abort')).resolves.toBeNull();
  });
});
