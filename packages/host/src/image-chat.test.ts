import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_CHAT_PARAMS, classifySession, summarizeSession, type AgentEvent, type ImageGenerationRequest } from '@nekko-agent/shared';
import { setDataDir } from './paths.js';
import { createSession, getSession, queuePrompt } from './sessions.js';
import { abortImageTurn, generateImageTurn, sessionImages } from './image-chat.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nekko-image-chat-'));
  setDataDir(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const params = { ...DEFAULT_IMAGE_CHAT_PARAMS, modelId: 'lmstudio/unsloth/FLUX.2-klein-9B-GGUF/flux-2-klein-9b-Q8_0', steps: 4, cfgScale: 1 };

describe('image chat turns', () => {
  it('appends the prompt and the picture, records the seed it used, and reports its stages', async () => {
    const s = createSession();
    const events: AgentEvent[] = [];
    const seen: ImageGenerationRequest[] = [];
    await generateImageTurn({ sessionId: s.id, prompt: '  a calico cat  ', params }, async (req, onStage) => {
      seen.push(req);
      onStage?.('loading');
      onStage?.('generating');
      return { created: 1, data: [{ b64_json: 'aGVsbG8=' }] };
    }, (e) => events.push(e));

    const saved = getSession(s.id)!;
    expect(saved.chatType).toBe('image');
    expect(saved.title).toBe('a calico cat');
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const reply = saved.messages[1];
    expect(reply.images).toEqual(['data:image/png;base64,aGVsbG8=']);
    // -1 asked for a random seed; the reply records the real one, and it is the one sent.
    expect(reply.generated?.seed).toBeGreaterThanOrEqual(0);
    expect(seen[0].seed).toBe(reply.generated?.seed);
    expect(reply.generated).toMatchObject({ steps: 4, cfgScale: 1, width: 1024, height: 1024 });
    expect(events.filter((e) => e.type === 'image_status').map((e) => (e as { stage: string }).stage)).toEqual(['generating', 'loading', 'generating']);
    expect(events.at(-1)).toMatchObject({ type: 'done', messageId: reply.id });

    // The board sees it as an image chat with one picture, and can fetch it.
    const summary = summarizeSession(saved);
    expect(summary.imageCount).toBe(1);
    expect(summary.recentTurns.at(-1)).toMatchObject({ role: 'assistant', text: '1024×1024 image', image: { width: 1024, height: 1024 } });
    expect(classifySession(summary).role).toBe('artist');
    expect(sessionImages(s.id, 4)).toEqual([{ messageId: reply.id, src: reply.images![0] }]);
  });

  it('keeps a fixed seed, and a failure lands in the chat as a reply and an error event', async () => {
    const s = createSession();
    const events: AgentEvent[] = [];
    await generateImageTurn({ sessionId: s.id, prompt: 'x', params: { ...params, seed: 42 } }, async (req) => {
      expect(req.seed).toBe(42);
      throw new Error('Missing vae');
    }, (e) => events.push(e));
    const saved = getSession(s.id)!;
    expect(saved.messages[1].content).toMatch(/could not be generated: Missing vae/);
    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'Missing vae' });
  });

  it('stops waiting when aborted, refuses a second concurrent turn, and keeps prompts queued mid-turn', async () => {
    const s = createSession();
    const events: AgentEvent[] = [];
    let release!: () => void;
    const turn = generateImageTurn({ sessionId: s.id, prompt: 'slow', params }, () => new Promise((r) => { release = () => r({ created: 1, data: [{ b64_json: 'eA==' }] }); }), (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 10));
    await generateImageTurn({ sessionId: s.id, prompt: 'again', params }, async () => ({ created: 1, data: [] }), (e) => events.push(e));
    expect(events.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/already generating/) });
    queuePrompt(s.id, 'next one');
    expect(abortImageTurn(s.id)).toBe(true);
    await turn;
    release();
    const saved = getSession(s.id)!;
    expect(saved.messages.at(-1)).toMatchObject({ role: 'assistant', interrupted: true });
    expect(saved.queue).toEqual(['next one']);
    expect(events.at(-1)?.type).toBe('done');
    expect(abortImageTurn(s.id)).toBe(false);
  });

  it('writes nothing for an incognito chat', async () => {
    const s = createSession();
    const { setSessionOptions } = await import('./sessions.js');
    setSessionOptions(s.id, { incognito: true });
    await generateImageTurn({ sessionId: s.id, prompt: 'secret', params }, async () => ({ created: 1, data: [{ b64_json: 'eA==' }] }), () => {});
    expect(getSession(s.id)!.messages).toEqual([]);
  });
});
