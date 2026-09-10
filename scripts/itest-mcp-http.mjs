// Exercises the MCP streamable-HTTP transport against a running Hypergate
// daemon (hypergated, default http://localhost:7777): detects the gateway,
// adds a scratch echo server through the daemon API, connects Agent Nekko's
// host MCP client to the gateway URL, and lists + calls a tool through it.
//
// Hypergate was itself renamed (kotrain-mcp → hypergate), which is why the
// checks below name `hypergated` and `../hypergate`.
// Usage: node scripts/itest-mcp-http.mjs [daemonBase]
import { createHost } from '@agent-nekko/host';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const base = process.argv[2] || 'http://localhost:7777';

const health = await (await fetch(`${base}/health`)).json().catch(() => null);
if (health?.service !== 'hypergated') {
  console.error(`No hypergated at ${base} — start it (npm run daemon in hypergate) and retry.`);
  process.exit(1);
}
const gw = await (await fetch(`${base}/api/gateway`)).json();
console.log(`gateway: ${gw.url} (daemon v${health.version})`);

// Give the gateway something to aggregate: hypergate's echo fixture.
const echoPath = resolve(process.cwd(), '../hypergate/packages/core/src/fixtures/echo-server.mjs');
await fetch(`${base}/api/servers/op-itest-echo`, { method: 'DELETE' }).catch(() => {});
const added = await (await fetch(`${base}/api/servers`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'op-itest-echo', name: 'itest echo', runtime: 'process', command: process.execPath, args: [echoPath], enabled: true }),
})).json();
if (added.state !== 'ready') {
  console.error(`echo server not ready: ${JSON.stringify(added)}`);
  process.exit(1);
}

const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'op-mcp-itest-')) });
await host.updateSettings({
  mcpServers: [{ id: 'hypergate', name: 'Hypergate gateway', command: '', args: [], url: gw.url, token: gw.token, enabled: true }],
});

const status = await host.mcpStatus();
const gwStatus = status.find((s) => s.id === 'hypergate');
console.log(`status: connected=${gwStatus?.connected} tools=${gwStatus?.tools.length} err=${gwStatus?.error ?? '-'}`);
const echoTool = gwStatus?.tools.find((t) => t.name === 'op-itest-echo__echo');

// Call the tool through the agent tool-routing path.
const { callMcpTool } = await import('../packages/host/dist/mcp.js');
const result = await callMcpTool({ id: 't1', name: 'mcp__hypergate__op-itest-echo__echo', input: { text: 'paw-to-paw' } });
console.log(`tool call: isError=${result.isError} output=${JSON.stringify(result.output)}`);

// Also prove a bad token is rejected.
await host.updateSettings({
  mcpServers: [{ id: 'bad', name: 'bad token', command: '', args: [], url: gw.url, token: 'wrong', enabled: true }],
});
const bad = (await host.mcpStatus()).find((s) => s.id === 'bad');
console.log(`bad-token status: connected=${bad?.connected} err=${bad?.error ?? '-'}`);

await fetch(`${base}/api/servers/op-itest-echo`, { method: 'DELETE' }).catch(() => {});

const pass = gwStatus?.connected && echoTool && !result.isError && result.output === 'paw-to-paw' && bad && !bad.connected;
console.log(`\n${pass ? 'MCP HTTP TRANSPORT PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
