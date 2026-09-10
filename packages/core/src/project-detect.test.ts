import { describe, it, expect } from 'vitest';
import { detectSessionWorkspace } from '@agent-nekko/shared';
import type { ProjectHint } from '@agent-nekko/shared';

const WS: ProjectHint[] = [
  { id: 'w1', name: 'agent-nekko', path: 'C:/Users/phili/code/agent-nekko' },
  { id: 'w2', name: 'hypergate', path: 'C:/Users/phili/code/hypergate' },
  { id: 'w3', name: 'app', path: 'C:/Users/phili/code/app' }, // generic name
];

describe('detectSessionWorkspace', () => {
  it('files a chat under the project it names in the prompt', () => {
    expect(detectSessionWorkspace({ text: 'fix the login bug in agent-nekko', workspaces: WS })).toBe('w1');
    expect(detectSessionWorkspace({ text: 'add a Hypergate MCP toggle', workspaces: WS })).toBe('w2');
  });

  it('uses an attached path inside a workspace, even without a name mention', () => {
    expect(
      detectSessionWorkspace({
        text: 'refactor this module',
        workspaces: WS,
        attachedPaths: ['C:/Users/phili/code/hypergate/src/daemon.ts'],
      }),
    ).toBe('w2');
  });

  it('prefers the attached-path project over a mere name mention', () => {
    // Prompt mentions agent-nekko, but the attached file lives in hypergate.
    expect(
      detectSessionWorkspace({
        text: 'port the agent-nekko approach here',
        workspaces: WS,
        attachedPaths: ['C:/Users/phili/code/hypergate/README.md'],
      }),
    ).toBe('w2');
  });

  it('stays under General for a generic chat', () => {
    expect(detectSessionWorkspace({ text: 'what is the capital of France?', workspaces: WS })).toBeNull();
    expect(detectSessionWorkspace({ text: 'write me a haiku', workspaces: WS })).toBeNull();
  });

  it('ignores over-generic workspace names (stopwords) on a bare mention', () => {
    // "app" is a stopword: mentioning it shouldn't file the chat under w3.
    expect(detectSessionWorkspace({ text: 'build a todo app', workspaces: WS })).toBeNull();
  });

  it('does not match substrings inside other words', () => {
    // "agent-nekkos" should not trip the "agent-nekko" workspace.
    expect(detectSessionWorkspace({ text: 'the agent-nekkos library', workspaces: WS })).toBeNull();
  });

  it('returns null when two different projects tie', () => {
    const ws: ProjectHint[] = [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'beta' },
    ];
    expect(detectSessionWorkspace({ text: 'compare alpha and beta', workspaces: ws })).toBeNull();
  });

  it('handles empty inputs safely', () => {
    expect(detectSessionWorkspace({ text: '', workspaces: [] })).toBeNull();
    expect(detectSessionWorkspace({ text: 'anything', workspaces: [] })).toBeNull();
  });
});
