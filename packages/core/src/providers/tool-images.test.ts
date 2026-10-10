import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@agent-nekko/shared';
import { withToolImages } from './tool-images.js';

describe('screenshot evidence transport', () => {
  it('places pixels after all tool results and leaves persisted history intact', () => {
    const messages: ChatMessage[] = [
      { id: 'a', role: 'assistant', content: '', createdAt: 1, toolCalls: [{ id: 'shot', name: 'capture', input: {} }, { id: 'other', name: 'read_file', input: {} }] },
      { id: 't1', role: 'tool', content: '', createdAt: 2, toolResult: { toolCallId: 'shot', output: 'shot.png', images: ['data:image/png;base64,eA=='] } },
      { id: 't2', role: 'tool', content: '', createdAt: 3, toolResult: { toolCallId: 'other', output: 'text' } },
      { id: 'u', role: 'user', content: 'continue', createdAt: 4 },
    ];
    const before = structuredClone(messages);
    const wire = withToolImages(messages);
    expect(wire.map(m => m.id)).toEqual(['a', 't1', 't2', 't1-evidence', 'u']);
    expect(wire[3].images).toEqual(messages[1].toolResult!.images);
    expect(wire[3].content).toContain('untrusted');
    expect(messages).toEqual(before);
  });
  it('never attaches images from failed tools', () => {
    const m: ChatMessage = { id: 't', role: 'tool', content: '', createdAt: 1, toolResult: { toolCallId: 'shot', output: 'denied', isError: true, images: ['data:image/png;base64,eA=='] } };
    expect(withToolImages([m])).toEqual([m]);
  });
});
