import { getSettings } from './store.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

/** Explicitly configured outbound coordinator. Tokens never return to renderer. */
export async function resourceQueue(action: string, input: Record<string, unknown> = {}): Promise<unknown> {
  if (!getSettings().experimental?.resourceQueue) throw new Error('Resource queue experiment is disabled');
  const path = join(dataDir(), 'resource-queue.json');
  let config: { url: string; token: string } | null = null;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { /* not configured */ }
  if (action === 'configure') {
    const url = new URL(String(input.url));
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Use HTTPS, or localhost for development');
    if (typeof input.token !== 'string' || input.token.length < 32) throw new Error('Client credential must have at least 32 characters');
    writeFileSync(path, JSON.stringify({ url: url.origin, token: input.token }), { mode: 0o600 });
    return { configured: true };
  }
  if (!config) throw new Error('Configure the coordinator first');
  const id = typeof input.id === 'string' && /^[a-f0-9-]+$/.test(input.id) ? input.id : '';
  const routes: Record<string, string> = { register: '/v1/resources/register', list: '/v1/jobs', claim: `/v1/jobs/${id}/claim`, heartbeat: `/v1/jobs/${id}/heartbeat`, result: `/v1/jobs/${id}/result` };
  if (!routes[action] || (['claim', 'heartbeat', 'result'].includes(action) && !id)) throw new Error('Invalid queue action');
  const response = await fetch(config.url + routes[action], { method: action === 'list' ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: action === 'list' ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Coordinator request failed (${response.status})`);
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Coordinator response too large');
  return JSON.parse(text);
}
