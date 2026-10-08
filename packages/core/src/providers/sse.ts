import { StreamStalledError, streamIdleMs } from './errors.js';

/** What `reader.read()` resolves to (the DOM's `ReadableStreamReadResult`, which Node's types lack). */
export type ReadResult<T> = { done: false; value: T } | { done: true; value?: undefined };

/**
 * `reader.read()` with an idle limit. A stream the server has silently
 * abandoned (a load balancer dropped it, the box went away mid-reply) never
 * resolves the read and never errors, which left a reply "thinking" for hours.
 * Past `idleMs` of silence the reader is cancelled and the read rejects with a
 * `StreamStalledError`, which the agent loop treats as worth a retry.
 */
export async function readWithIdle<T>(
  reader: { read(): Promise<ReadResult<T>>; cancel(reason?: unknown): Promise<void> },
  idleMs = streamIdleMs(),
): Promise<ReadResult<T>> {
  if (!(idleMs > 0)) return reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new StreamStalledError(idleMs);
      reader.cancel(err).catch(() => {});
      reject(err);
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a fetch Response body as a Server-Sent Events stream, yielding the
 * `data:` payloads as strings. Stops on `[DONE]`. Works with the WHATWG
 * ReadableStream available in Node 20+ and browsers.
 */
export async function* parseSSE(res: Response, idleMs?: number): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await readWithIdle(reader, idleMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Normalize CRLF after joining chunks, including a split CR/LF pair.
      buffer = buffer.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of rawEvent.split('\n')) {
          const trimmed = line.trimStart();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;
          if (data) yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
