import { randomInt } from 'crypto';
import type { AgentEvent, ChatMessage, ImageGenerationRequest, ImageGenerationResult, ImageTurnOptions } from '@nekko-agent/shared';
import { getSession, saveSession, saveTurnSession } from './sessions.js';

/**
 * One turn of an image-generation chat.
 *
 * There is no agent loop here: the prompt goes to a local image model and the
 * reply is the picture. It still lands in the transcript as an ordinary user
 * message and an assistant message (carrying the image and how it was made),
 * and it still emits the turn events every surface already listens for, so the
 * chat, the sidebar and the Command Center treat it like any other turn.
 */

type Generate = (request: ImageGenerationRequest, onStage?: (stage: 'loading' | 'generating') => void) => Promise<ImageGenerationResult>;

const running = new Map<string, AbortController>();

/** Stop waiting on an image turn. The model server may finish the image anyway; it is discarded. */
export function abortImageTurn(sessionId: string): boolean {
  const c = running.get(sessionId);
  if (!c) return false;
  c.abort();
  return true;
}

export async function generateImageTurn(opts: ImageTurnOptions, generate: Generate, emit: (e: AgentEvent) => void): Promise<void> {
  const { sessionId, prompt, params } = opts;
  const session = getSession(sessionId);
  if (!session) {
    emit({ type: 'error', sessionId, message: 'That chat no longer exists.' });
    return;
  }
  if (running.has(sessionId)) {
    emit({ type: 'error', sessionId, message: 'This chat is already generating an image.' });
    return;
  }
  const text = prompt.trim();
  if (!text) {
    emit({ type: 'error', sessionId, message: 'Describe the image you want first.' });
    return;
  }
  // -1 means "surprise me", but the reply records a real seed so the same
  // picture can be made again.
  const seed = params.seed >= 0 ? params.seed : randomInt(0, 2 ** 31 - 1);
  const controller = new AbortController();
  running.set(sessionId, controller);
  // As sendChat does: nothing touches disk for an incognito chat, and prompts
  // queued mid-turn (written straight to disk) survive this save.
  const persist = () => {
    if (session.incognito) return;
    saveTurnSession(session);
  };

  session.messages.push({ id: `msg_${Date.now().toString(36)}`, role: 'user', content: text, createdAt: Date.now() });
  if (session.title === 'New chat') {
    session.title = text.slice(0, 48);
    session.titleAuto = true;
  }
  session.chatType = 'image';
  session.imageParams = { ...params, seed: params.seed };
  session.modelId = params.modelId;
  // Read from disk just above, so nothing is stale yet; and the settings this
  // turn was sent with are the chat's now, which a merging save would undo.
  if (!session.incognito) saveSession(session);

  const size = `${params.width}×${params.height}`;
  emit({ type: 'image_status', sessionId, stage: 'generating', label: `Generating a ${size} image` });
  const started = Date.now();
  try {
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Stopped.'))));
    const result = await Promise.race([
      generate({ modelId: params.modelId, prompt: text, width: params.width, height: params.height, steps: params.steps, cfgScale: params.cfgScale, seed }, (stage) =>
        emit({ type: 'image_status', sessionId, stage, label: stage === 'loading' ? 'Loading the image model' : `Generating a ${size} image` }),
      ),
      aborted,
    ]);
    const images = result.data.map((d) => `data:image/png;base64,${d.b64_json}`);
    const reply: ChatMessage = {
      id: `msg_${(Date.now() + 1).toString(36)}`,
      role: 'assistant',
      content: '',
      images,
      generated: { modelId: params.modelId, width: params.width, height: params.height, steps: params.steps, cfgScale: params.cfgScale, seed, ms: Date.now() - started },
      createdAt: Date.now(),
    };
    session.messages.push(reply);
    persist();
    emit({ type: 'done', sessionId, messageId: reply.id });
  } catch (e) {
    const stopped = controller.signal.aborted;
    const reply: ChatMessage = {
      id: `msg_${(Date.now() + 1).toString(36)}`,
      role: 'assistant',
      content: stopped ? 'Stopped before the image finished.' : `The image could not be generated: ${(e as Error).message}`,
      interrupted: stopped || undefined,
      createdAt: Date.now(),
    };
    session.messages.push(reply);
    persist();
    if (stopped) emit({ type: 'done', sessionId, messageId: reply.id });
    else emit({ type: 'error', sessionId, message: (e as Error).message });
  } finally {
    running.delete(sessionId);
  }
}

/** The newest `limit` generated pictures in a chat, newest last. */
export function sessionImages(sessionId: string, limit: number): Array<{ messageId: string; src: string }> {
  const s = getSession(sessionId);
  if (!s) return [];
  const out: Array<{ messageId: string; src: string }> = [];
  const cap = Math.max(1, Math.min(12, Math.floor(limit) || 1));
  for (let i = s.messages.length - 1; i >= 0 && out.length < cap; i--) {
    const m = s.messages[i];
    if (m.role === 'assistant' && m.generated && m.images?.length) out.push({ messageId: m.id, src: m.images[0] });
  }
  return out.reverse();
}
