import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDecisions, DECISION_CATALOG } from './decisions.js';
import type { EngineDaemon } from './daemon.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const scratch = async () => { const d = await mkdtemp(join(tmpdir(), 'nekko-decide-')); dirs.push(d); return d; };

const fakeDownloads = () => {
  const started: Array<{ url: string; dest: string; headers?: Record<string, string> }> = [];
  return { started, downloads: { start: vi.fn(async (req) => { started.push(req); return req; }) } as never };
};

const request = { state: 'I was charged twice.', questions: { dept: { type: 'choice' as const, instructions: 'Which team?', criteria: ['billing', 'technical'] } } };

describe('decision models', () => {
  it('downloads one precision plus the shared files, pinned to a revision, and skips what is already whole', async () => {
    const models = await scratch();
    const { started, downloads } = fakeDownloads();
    const d = createDecisions({ modelsDir: () => models, downloads, daemon: () => undefined, typesafeKey: () => undefined });
    const res = await d.download('laya-en', 'int8');
    expect(res.ok).toBe(true);
    expect(started.map((s) => s.dest.split(/[\\/]/).pop())).toEqual(['tokenizer.json', 'tokenizer_config.json', 'rl_agent_config.json', 'config.json', 'model_int8.onnx']);
    expect(started.every((s) => s.url.includes('/resolve/0d1f7ebf46a3ea04ec4424df602f96ddefb66766/'))).toBe(true);

    // A file already at its published size is not fetched again.
    const dir = join(models, 'decision', 'laya-en');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'tokenizer_config.json'), 'x'.repeat(DECISION_CATALOG[0].shared[1].bytes));
    started.length = 0;
    await d.download('laya-en', 'int8');
    expect(started.map((s) => s.dest.split(/[\\/]/).pop())).not.toContain('tokenizer_config.json');
    expect((await d.download('nope')).ok).toBe(false);
  });

  it('lists only complete model dirs and refuses ids that escape the folder', async () => {
    const models = await scratch();
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined });
    const dir = join(models, 'decision', 'laya-en');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'model_fp16.onnx'), 'weights');
    expect(await d.models()).toEqual([]); // no tokenizer or config yet
    await writeFile(join(dir, 'tokenizer.json'), '{}');
    await writeFile(join(dir, 'rl_agent_config.json'), '{}');
    const [m] = await d.models();
    expect(m).toMatchObject({ id: 'laya-en', name: 'Laya (English)', precisions: ['fp16'] });
    await expect(d.remove('../../etc')).rejects.toThrow(/not a decision model id/);
  });

  it('runs locally through the daemon, and says why when there is no daemon', async () => {
    const models = await scratch();
    const daemon = { decideRun: vi.fn(async () => ({ model: 'laya-en', answers: { dept: { type: 'choice', choice: 'billing' } } })) } as unknown as EngineDaemon;
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => daemon, typesafeKey: () => undefined });
    const res = await d.run('local', request);
    expect(res).toMatchObject({ provider: 'local', model: 'laya-en', answers: { dept: { choice: 'billing' } } });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);

    const none = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined });
    await expect(none.run('local', request)).rejects.toThrow(/engine daemon/);
    expect((await none.status()).local.available).toBe(false);
    await expect(none.run('local', { state: '', questions: {} })).rejects.toThrow(/state is empty/);
  });

  it('calls TypeSafe with the key and jev-latest, and reports its errors', async () => {
    const models = await scratch();
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models')) return new Response('{}', { status: 401 });
      expect(url).toBe('https://api.typesafe.ai/v1/systemone');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer ts-key');
      const body = JSON.parse(String(init?.body));
      if (body.state === 'boom') return new Response(JSON.stringify({ error: { message: 'bad question' } }), { status: 400 });
      expect(body.model).toBe('jev-latest');
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { dept: { type: 'choice', choice: 'billing' } } }));
    }) as unknown as typeof globalThis.fetch;
    const d = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => 'ts-key', fetch });
    expect(await d.run('typesafe', request)).toMatchObject({ provider: 'typesafe', model: 'jev-1.13.0' });
    await expect(d.run('typesafe', { ...request, state: 'boom' })).rejects.toThrow('TypeSafe answered 400: bad question');
    expect(await d.checkTypesafe()).toEqual({ ok: false, message: 'TypeSafe rejected the key.' });
    const keyless = createDecisions({ modelsDir: () => models, downloads: fakeDownloads().downloads, daemon: () => undefined, typesafeKey: () => undefined, fetch });
    await expect(keyless.run('typesafe', request)).rejects.toThrow(/TypeSafe API key/);
  });
});
