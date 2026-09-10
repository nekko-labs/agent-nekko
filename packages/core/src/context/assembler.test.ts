import { describe, it, expect } from 'vitest';
import { assembleContext, isGuidelineFile } from './assembler.js';
import type { MemoryEntry } from '@agent-nekko/shared';

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

  it('recognizes guideline filenames', () => {
    expect(isGuidelineFile('AGENTS.md')).toBe(true);
    expect(isGuidelineFile('CLAUDE.md')).toBe(true);
    expect(isGuidelineFile('readme.md')).toBe(false);
  });
});
