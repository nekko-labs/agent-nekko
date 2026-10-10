import { describe, it, expect } from 'vitest';
import { assembleContext, isGuidelineFile, renderContextBlock } from './assembler.js';
import { estimateTokens } from '@nekko-agent/shared';
import type { MemoryEntry } from '@nekko-agent/shared';

const mem: MemoryEntry = {
  id: 'm1',
  scope: 'global',
  title: 'Prefers tabs',
  body: 'The user prefers tabs over spaces.',
  tags: [],
  createdAt: 0,
  updatedAt: 0,
};

describe('assembleContext', () => {
  it('produces one provenance item per source with token estimates', () => {
    const b = assembleContext({
      attached: [{ path: '/p/a.ts', content: 'const a = 1;' }],
      guidelines: [{ path: '/p/AGENTS.md', content: 'Be concise.' }],
      memory: [mem],
      connectorSnippets: [{ label: 'NEK-1', origin: 'linear', body: 'Fix the bug' }],
      indexSnippets: [],
    });
    expect(b.items).toHaveLength(4);
    expect(b.items.every((i) => i.tokens > 0)).toBe(true);
    expect(b.items.find((i) => i.source === 'guideline')?.label).toBe('AGENTS.md');
  });

  it('excludes toggled-off items from the total token count', () => {
    const b = assembleContext({
      attached: [{ path: '/p/a.ts', content: 'x'.repeat(400) }],
      guidelines: [],
      memory: [],
      connectorSnippets: [],
      indexSnippets: [],
      excluded: new Set(['file:/p/a.ts']),
    });
    expect(b.items[0].included).toBe(false);
    expect(b.totalTokens).toBe(0);
  });

  it('marks pinned items', () => {
    const b = assembleContext({
      attached: [],
      guidelines: [{ path: '/p/CLAUDE.md', content: 'Rules' }],
      memory: [],
      connectorSnippets: [],
      indexSnippets: [],
      pinned: new Set(['guideline:/p/CLAUDE.md']),
    });
    expect(b.items[0].pinned).toBe(true);
  });

  it('carries the full text of every item, not its preview', () => {
    // The preview is 160 characters. Rendering the prompt from previews is what
    // truncated every attached file on its way to the model while the inspector
    // went on reporting the token cost of the whole thing.
    const body = 'A'.repeat(5000);
    const b = assembleContext({
      attached: [{ path: '/p/big.ts', content: body }],
      guidelines: [],
      memory: [],
      connectorSnippets: [],
      indexSnippets: [],
    });
    expect(b.contents?.get('file:/p/big.ts')).toBe(body);
    expect(b.items[0].preview.length).toBeLessThan(200);
  });

  it('renders the whole file into the context block', () => {
    const body = 'B'.repeat(5000);
    const b = assembleContext({
      attached: [{ path: '/p/big.ts', content: body }],
      guidelines: [],
      memory: [],
      connectorSnippets: [],
      indexSnippets: [],
    });
    const block = renderContextBlock(b, b.contents ?? new Map());
    expect(block).toContain(body);
    // The truncation marker the preview would have added must not be there.
    expect(block).not.toContain('…');
  });

  it('keeps the reported tokens in step with what is rendered', () => {
    const body = 'C'.repeat(4000);
    const b = assembleContext({
      attached: [{ path: '/p/big.ts', content: body }],
      guidelines: [],
      memory: [],
      connectorSnippets: [],
      indexSnippets: [],
    });
    const block = renderContextBlock(b, b.contents ?? new Map());
    // The count described the whole file while the block held 160 characters of
    // it, so the two disagreed by more than an order of magnitude. They should
    // now be within a header's worth of each other.
    expect(estimateTokens(block)).toBeGreaterThanOrEqual(b.totalTokens * 0.9);
  });

  it('counts reasoning and tool traffic as part of the conversation', () => {
    const base = {
      attached: [],
      guidelines: [],
      memory: [],
      connectorSnippets: [],
      indexSnippets: [],
    };
    const textOnly = assembleContext({
      ...base,
      history: [{ role: 'assistant', content: 'Done.' }],
    });
    const withWork = assembleContext({
      ...base,
      history: [
        {
          role: 'assistant',
          content: 'Done.',
          reasoning: 'R'.repeat(2000),
          toolCalls: [{ name: 'read_file', input: { path: '/p/'.repeat(200) } }],
          toolResult: { output: 'T'.repeat(2000) },
        },
      ],
    });
    // The transcript is replayed in full, so a turn that thought and called
    // tools costs far more than its one-word answer suggests.
    expect(withWork.totalTokens).toBeGreaterThan(textOnly.totalTokens * 10);
  });

  it('recognizes guideline filenames', () => {
    expect(isGuidelineFile('AGENTS.md')).toBe(true);
    expect(isGuidelineFile('CLAUDE.md')).toBe(true);
    expect(isGuidelineFile('readme.md')).toBe(false);
  });
});
