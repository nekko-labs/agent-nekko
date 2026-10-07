import { describe, expect, it } from 'vitest';
import { parseSSE } from './sse.js';

function response(parts: string[]) {
  return new Response(new ReadableStream({ start(controller) {
    for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
    controller.close();
  } }));
}

describe('SSE framing', () => {
  for (const ending of ['\n', '\r\n']) {
    it(`reads replies with ${JSON.stringify(ending)} line endings across every byte boundary`, async () => {
      const stream = `: heartbeat${ending}data: {"text":"hello"}${ending}${ending}data: [DONE]${ending}${ending}`;
      const chunks = [];
      for await (const data of parseSSE(response([...stream]))) chunks.push(data);
      expect(chunks).toEqual(['{"text":"hello"}']);
    });
  }
  it('retains separate data payloads and ignores event metadata', async () => {
    const chunks = [];
    for await (const data of parseSSE(response(['event: message\ndata: first\ndata: second\n\n']))) chunks.push(data);
    expect(chunks).toEqual(['first', 'second']);
  });
  it('does not dispatch an unterminated event', async () => {
    const chunks = [];
    for await (const data of parseSSE(response(['data: incomplete\n']))) chunks.push(data);
    expect(chunks).toEqual([]);
  });
});
