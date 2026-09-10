import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { createHost, createDispatcher } from '@agent-nekko/host';
import { brandEnv, IpcChannels, IpcEvents } from '@agent-nekko/shared';
import { runRelayAgent } from './relay-agent.js';
import { runCli } from 'kotrain/run';
import { isLoopbackHost, tokenMatches, validateBindSecurity } from './security.js';
import { createApiSecurityHook } from './request-security.js';
import { registerWebhookRoutes } from './webhooks.js';

/** Subcommands handled by the embedded CLI (so `npx agent-nekko mcp|chat|…` works). */
const CLI_SUBCOMMANDS = new Set([
  'mcp', 'chat', 'status', 'sessions', 'watch', 'workspace', 'prompts', 'tasks',
  'skills', 'tools', 'models', 'train', 'help', 'version',
]);

const __dirname = dirname(fileURLToPath(import.meta.url));

/** NEKKO_* env, falling back to every earlier brand prefix. See `brandEnv`. */
const env = brandEnv;
/** Default data dir: ~/.nekko, but keep using an earlier brand's dir if one exists. */
function defaultDataDir(): string {
  const next = join(homedir(), '.nekko');
  if (existsSync(next)) return next;
  for (const name of ['.kotrain', '.nekkos', '.open-paw']) {
    const legacy = join(homedir(), name);
    if (existsSync(legacy)) return legacy;
  }
  return next;
}

const PORT = Number(env('PORT') ?? 1440);
const HOST = env('HOST') ?? '127.0.0.1';
const isLocal = isLoopbackHost(HOST);
const DATA_DIR = env('DATA_DIR') ?? defaultDataDir();
const TOKEN = env('TOKEN') ?? '';
const ALLOW_UNAUTHENTICATED = env('ALLOW_UNAUTHENTICATED') === '1';
const ALLOWED_HOSTS = (env('ALLOWED_HOSTS') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const ALLOWED_ORIGINS = (env('ALLOWED_ORIGINS') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const requireAuth = TOKEN !== '';

// Find the built renderer: explicit override, then the bundled `web/` (published
// npx package), then the in-repo desktop build (dev).
function findRendererDir(): string {
  const candidates = [
    env('RENDERER_DIR'),
    resolve(__dirname, 'web'),
    resolve(__dirname, '../../desktop/out/renderer'),
  ].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(join(d, 'index.html'))) ?? candidates[candidates.length - 1];
}
const RENDERER_DIR = findRendererDir();

async function main() {
  // Subcommand → embedded CLI (e.g. `npx agent-nekko mcp`, `kotrain status`).
  const sub = process.argv[2];
  if (sub && CLI_SUBCOMMANDS.has(sub)) {
    await runCli(process.argv.slice(2));
    return;
  }

  // Relay-agent mode: connect out to a relay instead of serving HTTP locally.
  const relayUrl = env('RELAY_URL');
  const relayRoom = env('ROOM');
  if (relayUrl && relayRoom) {
    await runRelayAgent({
      relayUrl,
      room: relayRoom,
      key: env('PAIR_KEY') || randomUUID().slice(0, 8),
      dataDir: DATA_DIR,
    });
    return;
  }

  if (!existsSync(join(RENDERER_DIR, 'index.html'))) {
    console.error(
      `[kotrain] Renderer not found at ${RENDERER_DIR}.\n` +
        `Build it first (npm run build -w @agent-nekko/desktop) or set NEKKO_RENDERER_DIR.`,
    );
    process.exit(1);
  }
  validateBindSecurity(HOST, TOKEN, ALLOW_UNAUTHENTICATED);

  // Report this build's version (for the web edition's refresh-when-updated check).
  if (env('VERSION') === undefined) {
    try {
      const { createRequire } = await import('node:module');
      process.env.NEKKO_VERSION = createRequire(import.meta.url)('../package.json').version ?? '0.0.0';
    } catch {
      /* leave unset → host reports 0.0.0 */
    }
  }

  const host = createHost({ dataDir: DATA_DIR });
  const dispatch = createDispatcher(host);
  const app = Fastify({ bodyLimit: 25 * 1024 * 1024 });
  await app.register(websocket);

  app.addHook('onRequest', createApiSecurityHook({
    host: HOST,
    port: PORT,
    token: TOKEN,
    allowedHosts: ALLOWED_HOSTS,
    allowedOrigins: ALLOWED_ORIGINS,
  }));

  const OAUTH_UNSUPPORTED = new Set<string>([IpcChannels.oauthBegin, IpcChannels.oauthFinish, IpcChannels.oauthCancel, IpcChannels.oauthSignOut, IpcChannels.providersImportCliAuth]);
  const OAUTH_UNSUPPORTED_MESSAGE = 'OAuth sign-in is only available in the desktop app.';

  // One HTTP route fronts the whole KotrainApi via the shared dispatcher.
  app.post<{ Params: { channel: string }; Body: { args?: unknown[] } }>('/api/:channel', async (req, reply) => {
    try {
      const channel = req.params.channel;
      if (OAUTH_UNSUPPORTED.has(channel)) {
        throw new Error(OAUTH_UNSUPPORTED_MESSAGE);
      }
      if (channel === IpcChannels.oauthStatus) {
        const [providerConfigId] = req.body?.args ?? [];
        reply.send({
          tokenKey: (providerConfigId as string) ?? '',
          connected: false,
          state: 'missing',
          message: OAUTH_UNSUPPORTED_MESSAGE,
        });
        return;
      }
      const result = await dispatch(channel, req.body?.args ?? []);
      reply.send(result ?? null);
    } catch (e) {
      reply.code(400).send({ error: (e as Error).message });
    }
  });

  // Inbound workflow webhook endpoint: per-trigger secret auth, 10 MB body cap, rate limit.
  registerWebhookRoutes(app, host);

  // Stream agent + index events over a WebSocket.
  app.get('/api/events', { websocket: true }, (socket: any, req) => {
    if (requireAuth) {
      const header = req.headers.authorization;
      const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined;
      const q = (req.query as Record<string, string> | undefined)?.token;
      if (!tokenMatches(TOKEN, bearer ?? q)) {
        socket.close();
        return;
      }
    }
    const onAgent = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.agentEvent, payload: e }));
    const onIndex = (s: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.indexProgress, payload: s }));
    const onTerminal = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.terminalEvent, payload: e }));
    const onChanges = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.changesUpdated, payload: e }));
    const onWorkflows = (s: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.workflowsUpdated, payload: s }));
    const onOauth = (s: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.oauthStatus, payload: s }));
    const onLimits = (e: unknown) => socket.send(JSON.stringify({ channel: IpcEvents.limitsUpdated, payload: e }));
    host.events.on('agentEvent', onAgent);
    host.events.on('indexProgress', onIndex);
    host.events.on('terminalEvent', onTerminal);
    host.events.on('changesUpdated', onChanges);
    host.events.on('workflowsUpdated', onWorkflows);
    host.events.on('oauthStatus', onOauth);
    host.events.on('limitsUpdated', onLimits);
    socket.on('close', () => {
      host.events.off('agentEvent', onAgent);
      host.events.off('indexProgress', onIndex);
      host.events.off('terminalEvent', onTerminal);
      host.events.off('changesUpdated', onChanges);
      host.events.off('workflowsUpdated', onWorkflows);
      host.events.off('oauthStatus', onOauth);
      host.events.off('limitsUpdated', onLimits);
    });
  });

  // Serve the built renderer (same UI as the desktop app).
  await app.register(fastifyStatic, { root: RENDERER_DIR, prefix: '/' });

  await app.listen({ port: PORT, host: HOST });
  const url = `http://${isLocal ? 'localhost' : HOST}:${PORT}`;
  console.log(`\nAgent Nekko web edition running at ${url}`);
  console.log(`   data dir: ${DATA_DIR}`);
  if (requireAuth) console.log(`   auth: token required (use Authorization: Bearer <token>; browser URLs may use ?token=… for WebSocket access)`);
  else if (!isLocal) console.log(`   ⚠ unauthenticated mode explicitly enabled; ensure an external auth layer protects this service.`);
  console.log(`   (offline-first, only reaches the model servers + connectors you configure)\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
