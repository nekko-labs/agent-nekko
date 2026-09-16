import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { EngineSettings, LocalModel } from '@agent-nekko/shared';
import { DEFAULT_ENGINE_SETTINGS } from '@agent-nekko/shared';
import { buildArgs, createEngineServer, type EngineServer } from './server.js';

/**
 * The router, driven against a stand-in for `llama-server`.
 *
 * The stand-in is a real child process speaking real HTTP on a real port, which
 * is the part worth testing: health polling, proxying, and eviction are all
 * about process and socket behaviour, and a mocked child would prove none of it.
 * What it does not test is llama.cpp itself, which is deliberate: this file owns
 * the routing, not the inference.
 */

/**
 * A fake llama-server: answers /health, echoes what it was asked for.
 *
 * Written to a file rather than passed to `node -e`, because in eval mode node
 * keeps parsing `--flags` as its own options and chokes on `--model`. A script
 * path ends node's option parsing, so the stub sees exactly the argv the router
 * built.
 */
const STUB = `
  const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
  const alias = process.argv[process.argv.indexOf('--alias') + 1];
  require('http').createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok' }));
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-stub-alias': alias });
      res.end(JSON.stringify({ served_by: alias, path: req.url, echo: body ? JSON.parse(body) : null }));
    });
  }).listen(port, '127.0.0.1');
`;

let stubPath = '';
let stubDir = '';

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), 'nekko-engine-'));
  stubPath = join(stubDir, 'stub-server.cjs');
  await writeFile(stubPath, STUB);
});
afterAll(async () => {
  await rm(stubDir, { recursive: true, force: true });
});

const model = (id: string): LocalModel => ({
  id,
  name: id,
  path: `/models/${id}.gguf`,
  sizeBytes: 4_000_000_000,
  layers: 32,
  kvHeads: 8,
  headDim: 128,
  maxContext: 32768,
  addedAt: Date.now(),
});

const MODELS = [model('qwen3-8b'), model('gemma3-12b')];

function make(settings: Partial<EngineSettings> = {}) {
  const current: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...settings };
  const server = createEngineServer({
    settings: () => current,
    binPath: async () => process.execPath,
    findModel: async (id) => MODELS.find((m) => m.id === id),
    listModels: async () => MODELS,
    getGpuStats: async () => null,
    // The real call is `llama-server <flags>`; here it is `node stub.cjs <flags>`,
    // so the stub reads the same `--port` and `--alias` the router passes.
    spawnFn: ((_bin: string, args: readonly string[]) =>
      spawn(process.execPath, [stubPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })) as unknown as typeof spawn,
  });
  return { server, settings: current };
}

let open: EngineServer | null = null;
afterEach(async () => {
  await open?.stop();
  open = null;
});

async function start(overrides: Partial<EngineSettings> = {}): Promise<{ server: EngineServer; port: number }> {
  const port = await freePort();
  const { server } = make({ port, ...overrides });
  const res = await server.start();
  expect(res.ok, res.message).toBe(true);
  open = server;
  return { server, port };
}

const call = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

describe('engine router', () => {
  it('serves the library at /v1/models with load state', async () => {
    const { port } = await start();
    const res = await call(port, '/v1/models');
    const body = (await res.json()) as { data: Array<{ id: string; state: string }> };
    expect(body.data.map((m) => m.id)).toEqual(['qwen3-8b', 'gemma3-12b']);
    expect(body.data[0].state).toBe('not-loaded');
  });

  it('loads a model and proxies inference to its process', async () => {
    const { server, port } = await start();
    expect((await server.load('qwen3-8b', { contextTokens: 4096 })).ok).toBe(true);

    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = (await res.json()) as { served_by: string; path: string };
    expect(body.served_by).toBe('qwen3-8b');
    expect(body.path).toBe('/v1/chat/completions');
  });

  it('routes each model to its own process', async () => {
    const { server, port } = await start({ maxLoaded: 2 });
    await server.load('qwen3-8b', {});
    await server.load('gemma3-12b', {});

    for (const id of ['qwen3-8b', 'gemma3-12b']) {
      const res = await call(port, '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: id }),
      });
      expect(((await res.json()) as { served_by: string }).served_by).toBe(id);
    }
  });

  it('loads on demand when a request names a model that is not resident', async () => {
    const { server, port } = await start({ jitLoad: true });
    expect(server.loadedIds()).toEqual([]);

    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gemma3-12b' }),
    });
    expect(((await res.json()) as { served_by: string }).served_by).toBe('gemma3-12b');
    expect(server.loadedIds()).toEqual(['gemma3-12b']);
  });

  it('refuses instead of loading when load-on-demand is off', async () => {
    const { port } = await start({ jitLoad: false });
    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-8b' }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/not loaded/i);
  });

  it('says which models exist when asked for one that does not', async () => {
    const { port } = await start();
    const res = await call(port, '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'not-a-model' }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('/v1/models');
  });

  it('evicts the least recently used model past the resident limit', async () => {
    const { server } = await start({ maxLoaded: 1 });
    await server.load('qwen3-8b', {});
    await server.load('gemma3-12b', {});
    expect(server.loadedIds()).toEqual(['gemma3-12b']);
  });

  it('rejects an unauthorized request when a key is set, and allows a good one', async () => {
    const { server, port } = await start({ apiKey: 'sekrit' });
    await server.load('qwen3-8b', {});

    expect((await call(port, '/v1/models')).status).toBe(401);
    const bad = await call(port, '/v1/models', { headers: { authorization: 'Bearer wrong' } });
    expect(bad.status).toBe(401);
    const good = await call(port, '/v1/models', { headers: { authorization: 'Bearer sekrit' } });
    expect(good.status).toBe(200);
  });

  it('leaves health unauthenticated so the port can be identified', async () => {
    const { port } = await start({ apiKey: 'sekrit' });
    const res = await call(port, '/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { service: string }).service).toBe('agent-nekko-engine');
  });

  it('sends no CORS headers unless origins are configured', async () => {
    const { port } = await start();
    const res = await call(port, '/v1/models', { headers: { origin: 'https://example.com' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows a configured origin and refuses an unlisted one', async () => {
    const { port } = await start({ corsOrigins: 'https://good.example' });
    const ok = await call(port, '/v1/models', { headers: { origin: 'https://good.example' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://good.example');
    const no = await call(port, '/v1/models', { headers: { origin: 'https://bad.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports a port that is already taken rather than failing silently', async () => {
    const { port } = await start();
    const { server: second } = make({ port });
    const res = await second.start();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('already in use');
  });

  it('unloading stops the model answering', async () => {
    const { server } = await start();
    await server.load('qwen3-8b', {});
    expect(server.resident()).toHaveLength(1);
    expect((await server.unload('qwen3-8b')).ok).toBe(true);
    expect(server.resident()).toHaveLength(0);
  });
});

describe('buildArgs', () => {
  const m = model('qwen3-8b');

  it('passes only what was asked for, so unset means the engine default', () => {
    expect(buildArgs(m, 9000, {})).toEqual([
      '--model', m.path,
      '--alias', 'qwen3-8b',
      '--host', '127.0.0.1',
      '--port', '9000',
    ]);
  });

  it('maps the cross-runtime parameters onto llama.cpp flags', () => {
    const args = buildArgs(m, 9000, { contextTokens: 16384, gpuLayers: 20, parallelSlots: 4 });
    expect(args).toContain('--ctx-size');
    expect(args[args.indexOf('--ctx-size') + 1]).toBe('16384');
    expect(args[args.indexOf('--n-gpu-layers') + 1]).toBe('20');
    expect(args[args.indexOf('--parallel') + 1]).toBe('4');
  });

  it('sets both KV cache halves, and only when they differ from the default', () => {
    expect(buildArgs(m, 9000, { kvCacheDtype: 'f16' })).not.toContain('--cache-type-k');
    const args = buildArgs(m, 9000, { kvCacheDtype: 'q8_0' });
    expect(args[args.indexOf('--cache-type-k') + 1]).toBe('q8_0');
    expect(args[args.indexOf('--cache-type-v') + 1]).toBe('q8_0');
  });

  it('writes flash attention as an explicit on/off, and omits it when unset', () => {
    expect(buildArgs(m, 9000, {})).not.toContain('--flash-attn');
    expect(buildArgs(m, 9000, { flashAttention: true })).toContain('on');
    expect(buildArgs(m, 9000, { flashAttention: false })).toContain('off');
  });

  it('only passes --no-mmap when mmap was explicitly turned off', () => {
    expect(buildArgs(m, 9000, { mmap: true })).not.toContain('--no-mmap');
    expect(buildArgs(m, 9000, {})).not.toContain('--no-mmap');
    expect(buildArgs(m, 9000, { mmap: false })).toContain('--no-mmap');
  });

  it('puts an embedding model into embedding mode', () => {
    const bge = { ...model('bge-small'), architecture: 'bert' };
    expect(buildArgs(bge, 9000, {})).toContain('--embedding');
    expect(buildArgs(m, 9000, {})).not.toContain('--embedding');
  });

  it('carries a seed of zero, which is a real seed and not an absent one', () => {
    expect(buildArgs(m, 9000, { seed: 0 })).toContain('--seed');
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}
