/**
 * Deterministic chat content for the perf harness: seeded transcripts and the
 * streamed reply. Everything is markdown of the shapes a real agent writes
 * (paragraphs, lists, fenced code, tables), numbered and varied so the engine's
 * runaway guard never mistakes it for a loop.
 */

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = (
  'agent build cache change check client commit config context daemon debug deploy diff draft engine event ' +
  'fetch file folder frame guard handler index input layout list model module network output parse patch ' +
  'plan pointer provider queue render reply request route runner schema scroll server session shell socket ' +
  'source split stream style summary task terminal test thread token tool trace update value view window worker'
).split(' ');

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const words = (r, n) => Array.from({ length: n }, () => pick(r, WORDS)).join(' ');
const sentence = (r) => {
  const w = words(r, 6 + Math.floor(r() * 10));
  const s = w[0].toUpperCase() + w.slice(1);
  return r() < 0.3 ? `${s} with \`${pick(r, WORDS)}()\` and **${pick(r, WORDS)}**.` : `${s}.`;
};

/** One assistant answer, marked so the harness can find it on screen. */
export function answerText(r, marker) {
  const parts = [`${sentence(r)} ${sentence(r)} ${marker}`];
  const shape = Math.floor(r() * 4);
  if (shape === 0 || shape === 3) {
    parts.push(Array.from({ length: 3 + Math.floor(r() * 3) }, () => `- ${sentence(r)}`).join('\n'));
  }
  if (shape === 1 || shape === 3) {
    const lines = Array.from({ length: 4 + Math.floor(r() * 6) }, (_, i) => `  const ${pick(r, WORDS)}${i} = ${pick(r, WORDS)}(${Math.floor(r() * 100)});`);
    parts.push(`\`\`\`ts\nfunction ${pick(r, WORDS)}() {\n${lines.join('\n')}\n}\n\`\`\``);
  }
  if (shape === 2) {
    const rows = Array.from({ length: 3 }, () => `| ${pick(r, WORDS)} | ${Math.floor(r() * 1000)} | ${pick(r, WORDS)} |`);
    parts.push(`| Name | Count | Note |\n| --- | --- | --- |\n${rows.join('\n')}`);
  }
  parts.push(`${sentence(r)} See [the ${pick(r, WORDS)} notes](https://example.com/${pick(r, WORDS)}).`);
  return parts.join('\n\n');
}

/**
 * A seeded transcript of `count` messages in four-message turns: the user asks,
 * the agent reads a file, the tool answers, the agent replies. The newest
 * message is an assistant answer carrying `lastMarker`.
 */
export function transcript({ seed, count, marker }) {
  const r = rng(seed);
  const messages = [];
  const base = Date.UTC(2026, 8, 1);
  let t = 0;
  const turns = Math.ceil(count / 4);
  for (let turn = 0; turn < turns; turn++) {
    const id = `m${seed}_${turn}`;
    const at = () => base + (t += 7_000);
    messages.push({ id: `${id}_u`, role: 'user', content: `${sentence(r)} ${sentence(r)}`, createdAt: at() });
    const call = { id: `${id}_c`, name: 'read_file', input: { path: `src/${pick(r, WORDS)}/${pick(r, WORDS)}.ts` } };
    messages.push({ id: `${id}_a1`, role: 'assistant', content: '', toolCalls: [call], createdAt: at() });
    const output = Array.from({ length: 6 }, () => `export const ${pick(r, WORDS)} = '${words(r, 3)}';`).join('\n');
    messages.push({ id: `${id}_t`, role: 'tool', content: output, toolResult: { toolCallId: call.id, output }, createdAt: at() });
    messages.push({ id: `${id}_a2`, role: 'assistant', content: answerText(r, marker(turn, turn === turns - 1)), createdAt: at() });
  }
  // Trim from the front so the newest turn (and its marker) survives.
  return messages.slice(messages.length - count);
}

/**
 * The long streamed reply, as the token-sized pieces the mock sends. About four
 * characters per token, which is what the app's own estimate assumes too.
 */
export function streamTokens(count, seed = 99) {
  const r = rng(seed);
  let text = '';
  let block = 0;
  while (text.length < count * 4) {
    block++;
    const shape = block % 5;
    if (shape === 0) text += `## Step ${block}\n\n`;
    else if (shape === 1) text += `${sentence(r)} ${sentence(r)} (${block})\n\n`;
    else if (shape === 2) text += `${Array.from({ length: 4 }, (_, i) => `- ${block}.${i} ${sentence(r)}`).join('\n')}\n\n`;
    else if (shape === 3) {
      const lines = Array.from({ length: 8 }, (_, i) => `  ${pick(r, WORDS)}_${block}_${i}(${Math.floor(r() * 1000)});`);
      text += `\`\`\`ts\n${lines.join('\n')}\n\`\`\`\n\n`;
    } else text += `${block}. ${sentence(r)}\n${block + 1}. ${sentence(r)}\n\n`;
  }
  return text.slice(0, count * 4).match(/[\s\S]{1,4}/g) ?? [];
}
