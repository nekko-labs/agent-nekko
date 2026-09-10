// End-to-end integration test against a real local model server.
// Usage: node scripts/itest-local.mjs [baseUrl] [model]
// Defaults target the user's LM Studio instance.
import { createProvider, runAgent, BUILTIN_TOOLS } from '@agent-nekko/core';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const baseUrl = process.argv[2] || 'http://10.5.0.2:1338';
const model = process.argv[3] || 'google/gemma-4-31b-qat';

const provider = createProvider({
  id: 'lmstudio-itest',
  kind: 'lmstudio',
  label: 'LM Studio (itest)',
  baseUrl, // intentionally without /v1 to exercise base() normalization
  enabled: true,
});

console.log(`\n== Provider test (${baseUrl}) ==`);
console.log(await provider.test());

console.log('\n== listModels ==');
const models = await provider.listModels();
console.log(models.map((m) => m.id).join(', '));

console.log('\n== Plain streaming chat (reasoning + content) ==');
let reasoningChars = 0;
let answer = '';
for await (const c of provider.chat({
  model,
  system: 'You are concise.',
  messages: [{ id: '1', role: 'user', content: 'Reply with exactly: HELLO KOTRAIN', createdAt: 0 }],
})) {
  if (c.type === 'reasoning') reasoningChars += c.delta.length;
  else if (c.type === 'text') answer += c.delta;
  else if (c.type === 'usage') console.log('usage:', c);
}
console.log(`reasoning chars streamed: ${reasoningChars}`);
console.log(`answer: ${JSON.stringify(answer.trim())}`);

console.log('\n== Agent loop with a real tool (read_file) ==');
const dir = mkdtempSync(join(tmpdir(), 'kotrain-itest-'));
const secretFile = join(dir, 'secret.txt');
writeFileSync(secretFile, 'The magic word is BISCUITS.', 'utf8');

const executeTool = async (call) => {
  const a = call.input || {};
  try {
    if (call.name === 'read_file') {
      return { toolCallId: call.id, output: readFileSync(a.path, 'utf8') };
    }
    if (call.name === 'list_dir') {
      return { toolCallId: call.id, output: readdirSync(a.path).join('\n') };
    }
    return { toolCallId: call.id, output: `Unsupported tool ${call.name}`, isError: true };
  } catch (e) {
    return { toolCallId: call.id, output: String(e), isError: true };
  }
};

const history = [
  {
    id: 'u1',
    role: 'user',
    content: `Read the file at ${secretFile.replace(/\\/g, '/')} using the read_file tool, then tell me the magic word.`,
    createdAt: 0,
  },
];

let toolsCalled = [];
let finalText = '';
for await (const ev of runAgent({
  sessionId: 'itest',
  provider,
  model,
  system: 'You are an assistant that uses tools to read files. Use read_file when asked.',
  history,
  tools: BUILTIN_TOOLS,
  executeTool,
  maxIterations: 6,
})) {
  if (ev.type === 'tool_call') {
    toolsCalled.push(ev.call.name);
    console.log(`  → tool_call: ${ev.call.name}(${JSON.stringify(ev.call.input)})`);
  } else if (ev.type === 'tool_result') {
    console.log(`  ← tool_result: ${ev.result.output.slice(0, 60)}`);
  } else if (ev.type === 'text') {
    finalText += ev.delta;
  } else if (ev.type === 'error') {
    console.log('  !! error:', ev.message);
  }
}

console.log(`\nfinal answer: ${finalText.trim()}`);
const pass =
  toolsCalled.includes('read_file') && /biscuits/i.test(finalText);
console.log(`\nScenario 1 ${pass ? 'PASS ✅' : 'FAIL ❌'}, tool used: ${toolsCalled.join(',') || 'none'}; mentioned magic word: ${/biscuits/i.test(finalText)}`);

console.log('\n== Scenario 2: multi-step (list_dir → read_file) ==');
writeFileSync(join(dir, 'readme.txt'), 'nothing here', 'utf8');
writeFileSync(join(dir, 'notes.txt'), 'just notes', 'utf8');
writeFileSync(join(dir, 'config.txt'), 'PASSWORD=hunter2', 'utf8');

const history2 = [
  {
    id: 'u1',
    role: 'user',
    content: `In the directory ${dir.replace(/\\/g, '/')}, find which file contains a PASSWORD and tell me the file name. Use list_dir first, then read_file.`,
    createdAt: 0,
  },
];
const tools2 = [];
let final2 = '';
let rounds = 0;
for await (const ev of runAgent({
  sessionId: 'itest2', provider, model,
  system: 'You use tools to inspect the filesystem. List a directory before reading files.',
  history: history2, tools: BUILTIN_TOOLS, executeTool, maxIterations: 8,
})) {
  if (ev.type === 'tool_call') { tools2.push(ev.call.name); rounds++; console.log(`  → ${ev.call.name}(${JSON.stringify(ev.call.input)})`); }
  else if (ev.type === 'text') final2 += ev.delta;
  else if (ev.type === 'error') console.log('  !! error:', ev.message);
}
console.log(`\nfinal: ${final2.trim().slice(0, 200)}`);
const pass2 = tools2.includes('list_dir') && tools2.includes('read_file') && /config\.txt/i.test(final2);
console.log(`Scenario 2 ${pass2 ? 'PASS ✅' : 'FAIL ❌'}, tools: ${tools2.join(',')}; named config.txt: ${/config\.txt/i.test(final2)}`);

const allPass = pass && pass2;
console.log(`\n${allPass ? 'ALL PASS ✅' : 'SOME FAILED ❌'}`);
process.exit(allPass ? 0 : 1);
