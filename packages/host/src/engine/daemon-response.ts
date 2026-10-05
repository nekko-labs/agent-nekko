/** Daemon/proxy failures may be plain text rather than an API JSON envelope. */
export async function readDaemonResponse<T>(res: Pick<Response, 'text' | 'ok' | 'status'>, channel: string): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Do not expose arbitrary response bodies (which may contain credentials).
    throw new Error(`${channel}: HTTP ${res.status}${res.ok ? ' returned invalid JSON' : ' returned a non-JSON error response'}`);
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : undefined;
    throw new Error(detail ? `${channel}: HTTP ${res.status}: ${detail}` : `${channel}: HTTP ${res.status}`);
  }
  return body as T;
}
