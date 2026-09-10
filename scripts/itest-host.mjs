// Exercises the full @agent-nekko/host path (settings store → sessions → chat
// orchestrator → provider → event emitter), proving the host extraction
// preserved behavior. Usage: node scripts/itest-host.mjs [baseUrl] [model]
import { createHost } from '@agent-nekko/host';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const baseUrl = process.argv[2] || 'http://10.5.0.2:1338';
const model = process.argv[3] || 'google/gemma-4-31b-qat';

const host = createHost({ dataDir: mkdtempSync(join(tmpdir(), 'kotrain-host-')) });

const provider = {
  id: 'lm', kind: 'lmstudio', label: 'LM Studio', baseUrl, enabled: true,
};
host.saveProvider(provider);
console.log('providers:', host.listProviders().map((p) => p.id).join(', '));
console.log('models:', (await host.listModels('lm')).map((m) => m.id).join(', '));

const session = host.createSession();
let text = '';
let reasoning = 0;
host.events.on('agentEvent', (e) => {
  if (e.type === 'text') text += e.delta;
  else if (e.type === 'reasoning') reasoning += e.delta.length;
});

await host.sendChat({ sessionId: session.id, providerId: 'lm', modelId: model, text: 'Reply with exactly: HELLO HOST' });

const saved = host.getSession(session.id);
console.log(`\nstreamed reasoning chars: ${reasoning}`);
console.log(`answer: ${JSON.stringify(text.trim())}`);
console.log(`persisted messages: ${saved?.messages.map((m) => m.role).join(',')}`);

const pass = /HELLO HOST/i.test(text) && saved?.messages.some((m) => m.role === 'assistant');
console.log(`\n${pass ? 'HOST PATH PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
