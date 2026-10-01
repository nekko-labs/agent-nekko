// Writes the inputs for the provider parity tests. Run when the fixtures
// need to change: node crates/nekko-agent/tests/golden/make-fixtures.mjs
// The expected outputs (requests.json, streams.json, models.json) are written
// by the real TS providers (packages/core/src/providers/providers.golden.test.ts,
// UPDATE_GOLDEN=1), and crates/nekko-agent/tests/golden.rs holds the port to them.
//
// Keys and tokens here are fake; they are recorded verbatim so the tests
// prove how each one is formatted into its header.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const write = (name, value) => writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);

// ---------------------------------------------------------------- providers

const cfg = (id, kind, baseUrl, extra = {}) => ({ id, kind, label: id, baseUrl, enabled: true, ...extra });

const providers = {
  openai: cfg('openai', 'openai', 'https://api.openai.com/v1', { apiKey: 'sk-test-openai' }),
  openrouter: cfg('openrouter', 'openrouter', 'https://openrouter.ai/api/v1', { apiKey: 'sk-or-test' }),
  lmstudio: cfg('lmstudio', 'lmstudio', 'http://localhost:1234/v1'),
  vllm: cfg('vllm', 'vllm', 'http://localhost:8000/v1/'),
  // Bare host: `/v1` is appended.
  llamacpp: cfg('llamacpp', 'llamacpp', 'http://127.0.0.1:11500', { apiKey: 'engine-token' }),
  // Padded, trailing slash, and an empty key (no Authorization header).
  'openai-compat': cfg('openai-compat', 'openai-compat', '  http://10.5.0.2:1338/  ', { apiKey: '' }),
  // The OpenAI-compatible URL pasted into an Ollama provider.
  ollama: cfg('ollama', 'ollama', 'http://localhost:11434/v1'),
  anthropic: cfg('anthropic', 'anthropic', 'https://api.anthropic.com', { apiKey: 'sk-ant-test' }),
  'anthropic-sub': cfg('anthropic-sub', 'anthropic', 'https://api.anthropic.com', {
    apiKey: 'oauth-access-token',
    auth: 'subscription',
    tokenKey: 'claude:acct',
  }),
  chatgpt: cfg('chatgpt', 'chatgpt', 'https://chatgpt.com/backend-api/', {
    apiKey: 'oauth-chatgpt-token',
    auth: 'subscription',
    accountId: 'acct-1',
  }),
  'chatgpt-no-account': cfg('chatgpt-no-account', 'chatgpt', 'https://chatgpt.com/backend-api', {
    apiKey: 'oauth-chatgpt-token',
    auth: 'subscription',
  }),
  'chatgpt-custom': cfg('chatgpt-custom', 'chatgpt', 'https://chatgpt.com/backend-api', {
    apiKey: 'oauth-chatgpt-token',
    accountId: 'acct-1',
    customModelId: '  my-codex-model ',
  }),
  'chatgpt-custom-dup': cfg('chatgpt-custom-dup', 'chatgpt', 'https://chatgpt.com/backend-api', {
    accountId: 'acct-1',
    customModelId: 'gpt-5',
  }),
};

// ----------------------------------------------------------------- requests

let clock = 1_790_000_000_000;
const msg = (role, content, extra = {}) => ({ id: `m${clock}`, role, content, createdAt: clock++, ...extra });
const user = (content, extra) => msg('user', content, extra);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

const tools = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', default: 120 } } },
  },
];

const roundTrip = [
  msg('system', 'An old system message kept in history.'),
  user('Fix the failing test in parser.ts'),
  msg('assistant', 'Let me look at it first.', {
    toolCalls: [
      { id: 'call_1', name: 'read_file', input: { path: 'src/parser.ts', lines: [1, 2.5], opts: { exact: 1.0, big: 1e21 } } },
      { id: 'call_2', name: 'bash', input: { command: 'npm test -- parser' } },
    ],
  }),
  msg('tool', '', { toolResult: { toolCallId: 'call_1', output: 'export function parse() {}' } }),
  msg('tool', '', { toolResult: { toolCallId: 'call_2', output: 'Error: 1 failing', isError: true } }),
  msg('assistant', '', { toolCalls: [{ id: 'call_3', name: 'bash', input: {} }] }),
  msg('tool', '', { toolResult: { toolCallId: 'call_3', output: '' } }),
  // A tool message with no result, and an assistant with an empty call list:
  // both fall through to the plain-message branches.
  msg('tool', 'orphan tool output'),
  msg('assistant', 'Fixed: the parser now handles empty input.', { toolCalls: [] }),
  user('Thanks!'),
];

const requests = {
  minimal: { model: 'm', messages: [user('hi')] },
  'system-and-tools': {
    model: 'qwen3-coder-30b',
    system: 'You are a coding agent.\nBe terse.',
    tools,
    temperature: 0.2,
    maxOutputTokens: 2048,
    messages: [user('List the files.')],
  },
  'wrap-up-no-tools': {
    model: 'm',
    system: 'You are a coding agent.',
    tools: [],
    messages: [user('Do the thing'), user('You have reached the step limit. Answer now.')],
  },
  images: {
    model: 'gemma-4-12b',
    messages: [
      user('What is in these?', { images: [PNG, JPEG, 'https://example.com/cat.png', 'data:image/png;base64,line\nbreak'] }),
      msg('assistant', 'A cat and a dot.', { images: [PNG] }),
      user('And no images here', { images: [] }),
    ],
  },
  'tool-round-trip': { model: 'm', system: 'sys', tools, messages: roundTrip },
  'think-on': { model: 'qwen3-8b', think: true, messages: [user('Why is the sky blue?')] },
  'think-off': { model: 'qwen3-8b', think: false, messages: [user('Why is the sky blue?')] },
  'opus-5-normal': { model: 'claude-opus-5', effort: 'normal', temperature: 0.7, messages: [user('hi')] },
  'opus-5-5-normal': { model: 'claude-opus-5-5', effort: 'normal', temperature: 0.7, messages: [user('hi')] },
  'opus-5-5-unset': { model: 'claude-opus-5-5', messages: [user('hi')] },
  'opus-5-low': { model: 'claude-opus-5', effort: 'low', temperature: 0.2, messages: [user('hi')] },
  'opus-5-medium': { model: 'claude-opus-5', effort: 'medium', temperature: 0.5, messages: [user('hi')] },
  'opus-5-xhigh': { model: 'claude-opus-5', effort: 'xhigh', temperature: 1, messages: [user('hi')] },
  'opus-5-max': { model: 'claude-opus-5', effort: 'max', temperature: 1, messages: [user('hi')] },
  'sonnet-4-6-high': { model: 'claude-sonnet-4-6', effort: 'high', temperature: 1, messages: [user('hi')] },
  'haiku-4-5-max': { model: 'claude-haiku-4-5-20251001', effort: 'max', temperature: 1, messages: [user('hi')] },
  'fable-normal': { model: 'claude-fable-5-1', effort: 'normal', messages: [user('hi')] },
  // The sampling rule reads the date as a minor version; the effort rule does not.
  'opus-4-dated': { model: 'claude-opus-4-20250514', effort: 'xhigh', temperature: 1, messages: [user('hi')] },
  'vendor-prefixed': { model: 'anthropic/Claude-Opus-5', effort: 'normal', messages: [user('hi')] },
  'zero-temperature-zero-cap': { model: 'm', temperature: 0, maxOutputTokens: 0, messages: [user('hi')] },
  'empty-system': { model: 'm', system: '', messages: [user('hi')] },
  unicode: {
    model: 'm',
    system: 'Réponds en français 🐱',
    messages: [
      user('Quote "this" and \\ that, then   a line separator, 日本語, and 😀'),
      msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'write', input: { text: 'ñ 😀 "q" \\ \u0001', n: -0.5 } }] }),
      msg('tool', '', { toolResult: { toolCallId: 'c1', output: 'wrote 😀' } }),
    ],
  },
  purpose: { model: 'm', purpose: 'title', maxOutputTokens: 32, messages: [user('Name this chat')] },
};

// ------------------------------------------------------------------ streams

const sse = (obj) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
const ev = (type, obj) => `event: ${type}\n${sse({ type, ...obj })}`;
const nd = (obj) => `${JSON.stringify(obj)}\n`;
const oa = (delta, extra = {}) => sse({ choices: [{ delta, ...extra }] });
const finish = (reason, usage) => sse({ choices: [{ delta: {}, finish_reason: reason }], ...(usage ? { usage } : {}) });
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

const streams = [
  // OpenAI-compatible
  {
    name: 'oa-text-usage',
    provider: 'openai-compat',
    responses: [{ chunks: [oa({ content: 'Hel' }), oa({ content: 'lo' }), finish('stop', { prompt_tokens: 5, completion_tokens: 2 }), sse('[DONE]')] }],
  },
  {
    name: 'oa-tool-fragments',
    provider: 'openai',
    responses: [
      {
        chunks: [
          oa({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_', arguments: '{"pa' } }] }),
          oa({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'bash', arguments: '' } }] }),
          oa({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }),
          oa({ tool_calls: [{ index: 1, function: { arguments: '{"command":"ls"}' } }] }),
          finish('tool_calls'),
          sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 20 } }),
          sse('[DONE]'),
        ],
      },
    ],
  },
  {
    name: 'oa-tool-no-id-no-index',
    provider: 'llamacpp',
    responses: [
      {
        chunks: [
          oa({ tool_calls: [{ function: { name: 'bash', arguments: '{"command":' } }] }),
          oa({ tool_calls: [{ function: { arguments: '"pwd"}' } }] }),
          oa({ tool_calls: [{ index: 3, function: { name: 'noargs' } }] }),
          finish('tool_calls', { prompt_tokens: 9, completion_tokens: 4 }),
          sse('[DONE]'),
        ],
      },
    ],
  },
  {
    name: 'oa-tool-args-odd',
    provider: 'openai-compat',
    responses: [
      {
        chunks: [
          oa({ tool_calls: [{ index: 0, id: 'bad', function: { name: 'a', arguments: '{bad' } }] }),
          oa({ tool_calls: [{ index: 1, id: 'arr', function: { name: 'b', arguments: '[1,2.0,"x"]' } }] }),
          oa({ tool_calls: [{ index: 2, id: 'num', function: { name: 'c', arguments: ' 42 ' } }] }),
          finish('tool_calls'),
          // A second batch after the first finish: the accumulator was cleared.
          oa({ tool_calls: [{ index: 0, id: 'again', function: { name: 'd', arguments: '{}' } }] }),
          finish('tool_calls'),
          sse('[DONE]'),
        ],
      },
    ],
  },
  {
    name: 'oa-usage-before-calls-in-one-event',
    provider: 'vllm',
    responses: [
      {
        chunks: [
          sse({
            choices: [
              {
                delta: { content: 'ok', tool_calls: [{ index: 0, id: 'x', function: { name: 'n', arguments: '{"a":1}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          sse('[DONE]'),
        ],
      },
    ],
  },
  {
    name: 'oa-reasoning',
    provider: 'lmstudio',
    responses: [
      {
        chunks: [
          oa({ reasoning_content: 'Let me think' }),
          oa({ reasoning: ' carefully.' }),
          oa({ content: '', reasoning_content: ' More.' }),
          // `??`: an empty reasoning_content hides `reasoning`.
          oa({ reasoning_content: '', reasoning: 'hidden' }),
          oa({ reasoning_content: null, reasoning: ' Shown.' }),
          oa({ content: '42' }),
          finish('stop'),
          sse('[DONE]'),
        ],
      },
    ],
  },
  {
    name: 'oa-nothing-generated',
    provider: 'openai',
    responses: [{ chunks: [finish('stop', { prompt_tokens: 5, completion_tokens: 0 }), sse('[DONE]')] }],
  },
  {
    name: 'oa-usage-zeros-and-missing',
    provider: 'openai',
    responses: [{ chunks: [oa({ content: 'x' }), sse({ choices: [], usage: {} }), sse({ usage: null }), sse('[DONE]')] }],
  },
  {
    name: 'oa-byte-splits',
    provider: 'openai-compat',
    responses: [
      {
        body: oa({ content: 'café 😀 ' }) + oa({ reasoning_content: '日本' }) + oa({ content: 'end' }) + finish('stop') + sse('[DONE]'),
        // Mid-emoji, mid-"é", mid-"\n\n", mid-"data:", and one byte at a time for a stretch.
        cuts: [3, 7, 37, 39, 40, 41, 42, 43, 44, 45, 46, 60, 61, 62, 63, 64, 80, 81, 82, 83, 84, 85, 86],
      },
    ],
  },
  {
    name: 'oa-framing-noise',
    provider: 'openai-compat',
    responses: [
      {
        chunks: [
          ': keep-alive comment\n\n',
          'event: message\nid: 1\nretry: 100\n' + oa({ content: 'a' }),
          'data: {not json\n\n',
          'data:\n\n',
          'data:    \n\n',
          '   data: {"choices":[{"delta":{"content":"b"}}]}   \n\n',
          'DATA: {"choices":[{"delta":{"content":"ignored"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"c"}}]}\ndata: {"choices":[{"delta":{"content":"d"}}]}\n\n',
          'data: 123\n\ndata: "str"\n\ndata: []\n\n',
          sse('[DONE]'),
        ],
      },
    ],
  },
  {
    name: 'oa-done-mid-event',
    provider: 'openai-compat',
    responses: [{ chunks: [`data: ${JSON.stringify({ choices: [{ delta: { content: 'kept' } }] })}\ndata: [DONE]\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'lost' } }] })}\n\n${oa({ content: 'lost too' })}`] }],
  },
  {
    name: 'oa-no-done-trailing-dropped',
    provider: 'openai-compat',
    responses: [{ chunks: [oa({ content: 'a' }), `data: ${JSON.stringify({ choices: [{ delta: { content: 'no blank line' } }] })}\n`] }],
  },
  {
    name: 'oa-crlf-framing',
    provider: 'openai-compat',
    responses: [{ chunks: [`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\r\n\r\n`, 'data: [DONE]\r\n\r\n'] }],
  },
  {
    name: 'oa-invalid-utf8',
    provider: 'openai-compat',
    responses: [{ bodyHex: hex('data: {"choices":[{"delta":{"content":"a') + 'ff' + hex('b"}}]}\n\n') + 'e282' }],
  },
  {
    name: 'oa-http-401-api-error',
    provider: 'openai',
    responses: [{ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided.', type: 'invalid_request_error' } }) }],
  },
  { name: 'oa-http-500-empty', provider: 'openai-compat', responses: [{ status: 500, body: '' }] },
  { name: 'oa-http-429-long-text', provider: 'openrouter', responses: [{ status: 429, body: `Too many requests 😀 ${'x'.repeat(300)}` }] },
  { name: 'oa-http-400-message-not-string', provider: 'openai', responses: [{ status: 400, body: '{"error":{"message":{"nested":true}}}' }] },
  { name: 'oa-network-error', provider: 'openai-compat', responses: [{ networkError: 'fetch failed' }] },
  { name: 'oa-network-econnrefused', provider: 'llamacpp', responses: [{ networkError: 'connect ECONNREFUSED 127.0.0.1:11500' }] },
  { name: 'oa-network-other', provider: 'openai', responses: [{ networkError: 'weird thing' }] },

  // Anthropic
  {
    name: 'an-text-tool-usage',
    provider: 'anthropic',
    request: 'system-and-tools',
    responses: [
      {
        headers: { 'anthropic-ratelimit-requests-remaining': '49', 'request-id': 'req_1' },
        chunks: [
          ev('message_start', { message: { id: 'msg_1', usage: { input_tokens: 120, output_tokens: 1 } } }),
          ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
          ev('ping', {}),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Reading ' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'it.' } }),
          ev('content_block_stop', { index: 0 }),
          ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } }),
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path": "a' } }),
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '.ts"}' } }),
          ev('content_block_stop', { index: 1 }),
          ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
          ev('message_stop', {}),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'after stop' } }),
        ],
      },
    ],
  },
  {
    name: 'an-thinking-ignored-but-timed',
    provider: 'anthropic-sub',
    request: 'opus-5-normal',
    responses: [
      {
        chunks: [
          ev('message_start', { message: { usage: { input_tokens: 7 } } }),
          ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
          ev('content_block_stop', { index: 0 }),
          ev('message_delta', { usage: { output_tokens: 3 } }),
          ev('message_delta', { delta: {} }),
          ev('message_stop', {}),
        ],
      },
    ],
  },
  {
    name: 'an-tool-no-json-and-bad-json',
    provider: 'anthropic',
    responses: [
      {
        chunks: [
          ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't0', name: 'noargs' } }),
          ev('content_block_stop', { index: 0 }),
          ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 't1', name: 'broken' } }),
          ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } }),
          ev('content_block_stop', { index: 1 }),
          // An input_json_delta with no open tool block is dropped.
          ev('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } }),
          ev('message_delta', { usage: { output_tokens: 0 } }),
        ],
      },
    ],
  },
  {
    name: 'an-stream-error',
    provider: 'anthropic',
    responses: [
      {
        chunks: [
          ev('message_start', { message: { usage: { input_tokens: 3 } } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Partial' } }),
          ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }),
          ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'never' } }),
        ],
      },
    ],
  },
  { name: 'an-stream-error-no-message', provider: 'anthropic', responses: [{ chunks: [sse({ type: 'error' })] }] },
  {
    name: 'an-no-message-stop',
    provider: 'anthropic',
    responses: [{ chunks: [ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'cut' } })] }],
  },
  {
    name: 'an-retry-without-temperature',
    provider: 'anthropic',
    request: 'sonnet-4-6-high',
    chats: 2,
    responses: [
      { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` is deprecated for this model.' } }) },
      { headers: { 'x-attempt': '2' }, chunks: [ev('message_stop', {})] },
      // The next chat opens on the learned shape.
      { chunks: [ev('message_stop', {})] },
    ],
  },
  {
    name: 'an-retry-without-effort',
    provider: 'anthropic',
    request: 'opus-5-xhigh',
    responses: [
      { status: 400, body: JSON.stringify({ type: 'error', error: { message: '`output_config` is not supported for this model.' } }) },
      { chunks: [ev('message_stop', {})] },
    ],
  },
  {
    name: 'an-retry-to-neither',
    provider: 'anthropic',
    request: 'opus-5-normal',
    chats: 2,
    responses: [
      { status: 400, body: '{"error":{"message":"output_config: unexpected field"}}' },
      { status: 400, body: '{"error":{"message":"top_k and temperature are not supported"}}' },
      { chunks: [ev('message_stop', {})] },
      { chunks: [ev('message_stop', {})] },
    ],
  },
  {
    name: 'an-retry-exhausted',
    provider: 'anthropic',
    request: 'sonnet-4-6-high',
    responses: [
      { status: 400, body: '`temperature` is deprecated for this model.' },
      { status: 400, body: '`temperature` is deprecated for this model.' },
      { status: 400, body: `\`temperature\` is deprecated for this model. ${'é'.repeat(250)}` },
    ],
  },
  { name: 'an-400-not-sampling', provider: 'anthropic', request: 'opus-5-normal', responses: [{ status: 400, body: '{"error":{"message":"max_tokens: must be greater than 0"}}' }] },
  { name: 'an-401', provider: 'anthropic-sub', responses: [{ status: 401, body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }] },
  { name: 'an-network-error', provider: 'anthropic', responses: [{ networkError: 'fetch failed' }] },

  // ChatGPT
  {
    name: 'cg-full',
    provider: 'chatgpt',
    request: 'think-on',
    responses: [
      {
        headers: { 'x-codex-primary-used-percent': '12' },
        chunks: [
          sse({ type: 'response.created', response: { id: 'r1' } }),
          sse({ type: 'response.reasoning_summary_text.delta', delta: 'thinking ' }),
          sse({ type: 'response.reasoning_summary_text.delta', delta: '' }),
          sse({ type: 'response.output_text.delta', delta: 'Hello' }),
          sse({ type: 'response.output_text.delta', delta: ' world' }),
          sse({ type: 'response.output_item.done', item: { type: 'message', content: [] } }),
          sse({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read_file', arguments: '{"path":"b.ts"}' } }),
          sse({ type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_2', name: 'bash', arguments: '' } }),
          sse({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 7 } } }),
          sse({ type: 'response.output_text.delta', delta: 'after' }),
        ],
      },
    ],
  },
  {
    name: 'cg-incomplete',
    provider: 'chatgpt',
    responses: [{ chunks: [sse({ type: 'response.output_text.delta', delta: 'partial' }), sse({ type: 'response.incomplete', response: { usage: { input_tokens: 4, output_tokens: 2 } } })] }],
  },
  { name: 'cg-completed-no-usage', provider: 'chatgpt', responses: [{ chunks: [sse({ type: 'response.completed', response: {} })] }] },
  { name: 'cg-failed', provider: 'chatgpt', responses: [{ chunks: [sse({ type: 'response.output_text.delta', delta: 'a' }), sse({ type: 'response.failed', response: { error: { message: 'ran out of room' } } })] }] },
  { name: 'cg-error', provider: 'chatgpt', responses: [{ chunks: [sse({ type: 'error', error: { message: 'model overloaded' } })] }] },
  { name: 'cg-error-top-level-message', provider: 'chatgpt', responses: [{ chunks: [sse({ type: 'error', message: 'rate limited', code: 429 })] }] },
  { name: 'cg-error-unknown', provider: 'chatgpt', responses: [{ chunks: [sse({ type: 'response.failed', response: {} })] }] },
  { name: 'cg-no-completed', provider: 'chatgpt', responses: [{ chunks: [sse({ type: 'response.output_text.delta', delta: 'x' }), sse('[DONE]')] }] },
  { name: 'cg-401-headers-first', provider: 'chatgpt', responses: [{ status: 401, headers: { 'x-codex-primary-used-percent': '100' }, body: 'nope' }] },
  { name: 'cg-no-account-id', provider: 'chatgpt-no-account', responses: [] },
  { name: 'cg-network-error', provider: 'chatgpt', responses: [{ networkError: 'fetch failed' }] },

  // Ollama
  {
    name: 'ol-text-usage',
    provider: 'ollama',
    request: 'system-and-tools',
    responses: [
      {
        chunks: [
          nd({ model: 'm', message: { role: 'assistant', content: 'Hel' }, done: false }),
          nd({ model: 'm', message: { role: 'assistant', content: 'lo' }, done: false }),
          nd({ model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 26, eval_count: 2, eval_duration: 123456789 }),
          nd({ message: { content: 'after done' } }),
        ],
      },
    ],
  },
  {
    name: 'ol-thinking-and-tools',
    provider: 'ollama',
    request: 'think-on',
    responses: [
      {
        chunks: [
          nd({ message: { role: 'assistant', content: '', thinking: 'Considering' } }),
          nd({ message: { role: 'assistant', content: '', thinking: ' options.' } }),
          nd({
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'read_file', arguments: { path: 'a.ts', n: 1.0, f: 0.5 } } },
                { function: { name: 'bash', arguments: { command: 'ls 😀' } } },
                { function: { name: 'noargs' } },
              ],
            },
          }),
          nd({ done: true, prompt_eval_count: 10, eval_count: 30, eval_duration: 2500000 }),
        ],
      },
    ],
  },
  { name: 'ol-eval-under-a-millisecond', provider: 'ollama', responses: [{ chunks: [nd({ message: { content: 'x' } }), nd({ done: true, eval_count: 1, eval_duration: 400000 })] }] },
  { name: 'ol-eval-duration-string', provider: 'ollama', responses: [{ chunks: [nd({ message: { content: 'x' } }), nd({ done: true, eval_duration: '5000000' })] }] },
  { name: 'ol-no-eval-duration', provider: 'ollama', responses: [{ chunks: [nd({ message: { content: 'x' } }), nd({ done: true, prompt_eval_count: 1, eval_count: 1 })] }] },
  { name: 'ol-nothing-generated', provider: 'ollama', responses: [{ chunks: [nd({ done: true })] }] },
  {
    name: 'ol-byte-splits-and-noise',
    provider: 'ollama',
    responses: [
      {
        body: `${nd({ message: { content: 'café 😀' } })}\n   \n{not json}\n  ${nd({ message: { content: ' end' } })}${nd({ done: true, eval_duration: 1e6 })}`,
        cuts: [5, 30, 31, 32, 33, 34, 50],
      },
    ],
  },
  {
    name: 'ol-last-line-without-newline',
    provider: 'ollama',
    responses: [{ chunks: [nd({ message: { content: 'x' } }), JSON.stringify({ done: true, eval_count: 5 })] }],
  },
  { name: 'ol-http-500', provider: 'ollama', responses: [{ status: 500, body: '{"error":"model not found"}' }] },
  { name: 'ol-network-error', provider: 'ollama', responses: [{ networkError: 'fetch failed' }] },
];

// ------------------------------------------------------------------- models

const json = (value, status = 200) => ({ status, body: JSON.stringify(value) });

const models = [
  {
    name: 'openai',
    provider: 'openai',
    responses: {
      'https://api.openai.com/v1/models': json({
        data: [
          { id: 'gpt-5', object: 'model', context_length: 400000, pricing: { prompt: '0.00001', completion: '0.00003' } },
          { id: 'gpt-4.1', top_provider: { context_length: 1047576 }, name: 'ignored off OpenRouter' },
          { id: 'o3', context_length: null, top_provider: { context_length: 200000 } },
        ],
      }),
    },
  },
  {
    name: 'openrouter',
    provider: 'openrouter',
    responses: {
      'https://openrouter.ai/api/v1/models': json({
        data: [
          { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', context_length: 400000, pricing: { prompt: '0.00000125', completion: '0.00001' }, supported_parameters: ['tools', 'temperature'] },
          { id: 'meta/llama', name: '', top_provider: { context_length: 8192 }, pricing: { prompt: '', completion: '0' }, supported_parameters: ['temperature'] },
          { id: 'x/unpriced', name: 'Unpriced', pricing: { prompt: 'n/a', completion: '0' } },
          { id: 'x/no-pricing' },
        ],
      }),
    },
  },
  { name: 'vllm', provider: 'vllm', responses: { 'http://localhost:8000/v1/models': json({ object: 'list', data: [{ id: 'Qwen/Qwen3-8B', max_model_len: 32768 }] }) } },
  { name: 'llamacpp-bare-url', provider: 'llamacpp', responses: { 'http://127.0.0.1:11500/v1/models': json({ data: [{ id: 'gemma-4-12b' }] }) } },
  { name: 'openai-compat-no-data', provider: 'openai-compat', responses: { 'http://10.5.0.2:1338/v1/models': json({ object: 'list' }) } },
  {
    name: 'lmstudio-native',
    provider: 'lmstudio',
    responses: {
      'http://localhost:1234/api/v0/models': json({
        data: [
          { id: 'qwen3-8b', state: 'loaded', loaded_context_length: 8192, max_context_length: 32768 },
          { id: 'gemma-4-12b', state: 'not-loaded', max_context_length: 131072 },
        ],
      }),
    },
  },
  {
    name: 'lmstudio-native-404-falls-back',
    provider: 'lmstudio',
    responses: {
      'http://localhost:1234/api/v0/models': json({ error: 'not found' }, 404),
      'http://localhost:1234/v1/models': json({ data: [{ id: 'qwen3-8b' }] }),
    },
  },
  {
    name: 'lmstudio-native-unreachable-falls-back',
    provider: 'lmstudio',
    responses: { 'http://localhost:1234/v1/models': json({ data: [{ id: 'qwen3-8b' }] }) },
  },
  {
    name: 'lmstudio-native-empty-list-wins',
    provider: 'lmstudio',
    responses: { 'http://localhost:1234/api/v0/models': json({ data: [] }), 'http://localhost:1234/v1/models': json({ data: [{ id: 'unused' }] }) },
  },
  { name: 'openai-401', provider: 'openai', responses: { 'https://api.openai.com/v1/models': json({ error: { message: 'Incorrect API key provided.' } }, 401) } },
  { name: 'openai-503-text', provider: 'openai', responses: { 'https://api.openai.com/v1/models': { status: 503, body: 'upstream unavailable' } } },
  { name: 'openai-unreachable', provider: 'openai', responses: {} },
  {
    name: 'ollama',
    provider: 'ollama',
    responses: {
      'http://localhost:11434/api/tags': json({
        models: [
          { name: 'llama3:8b', size: 4661224676, details: { family: 'llama', quantization_level: 'Q4_0', parameter_size: '8B' } },
          { name: 'qwen3:8b', size: 5225376047, details: { family: 'qwen3', quantization_level: null } },
          { name: 'tiny:latest', size: 1 },
        ],
      }),
      'http://localhost:11434/api/ps': json({ models: [{ name: 'llama3:8b', size_vram: 5137025024 }, { name: 'tiny:latest', size_vram: 0 }] }),
    },
  },
  {
    name: 'ollama-ps-unreachable',
    provider: 'ollama',
    responses: { 'http://localhost:11434/api/tags': json({ models: [{ name: 'llama3:8b', size: 10 }] }) },
  },
  {
    name: 'ollama-error-status-still-parsed',
    provider: 'ollama',
    responses: {
      'http://localhost:11434/api/tags': json({ models: [{ name: 'a' }] }, 500),
      'http://localhost:11434/api/ps': { status: 200, body: 'not json' },
    },
  },
  { name: 'ollama-unreachable', provider: 'ollama', responses: {} },
  { name: 'anthropic', provider: 'anthropic', responses: {} },
  { name: 'chatgpt', provider: 'chatgpt', responses: {} },
  { name: 'chatgpt-custom', provider: 'chatgpt-custom', responses: {} },
  { name: 'chatgpt-custom-duplicate', provider: 'chatgpt-custom-dup', responses: {} },
];

// Every provider sees every request fixture.
const requestMatrix = Object.keys(providers).filter((p) => !['chatgpt-no-account', 'chatgpt-custom', 'chatgpt-custom-dup'].includes(p));

write('providers.json', providers);
write('request-cases.json', { providers: requestMatrix, requests });
write('stream-cases.json', streams);
write('model-cases.json', models);
