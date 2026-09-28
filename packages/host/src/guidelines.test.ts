import { describe, expect, it } from 'vitest';
import { isPointerTo } from './chat.js';

/**
 * Why this exists: a repo that keeps both `AGENTS.md` and a `CLAUDE.md` saying
 * "see AGENTS.md" was loading the same guidance twice, which put it in the
 * context window twice and drew two Guidelines sections in the inspector.
 */
describe('isPointerTo', () => {
  const AGENTS = { name: 'AGENTS.md' };

  it('spots a short file that redirects to a sibling', () => {
    const claude = {
      name: 'CLAUDE.md',
      content:
        '# Claude\n\nSee [AGENTS.md](AGENTS.md) for all guidance. This file exists only because ' +
        'Claude Code reads `CLAUDE.md` by default.',
    };
    expect(isPointerTo(claude, [AGENTS, claude])).toBe(true);
  });

  it('keeps a long document that merely cites another guideline', () => {
    // Citing AGENTS.md is not the same as being a stub for it: a real guideline
    // that happens to reference its sibling must still reach the model.
    const long = {
      name: 'CLAUDE.md',
      content: 'See AGENTS.md for context.\n' + 'Real guidance here. '.repeat(60),
    };
    expect(isPointerTo(long, [AGENTS, long])).toBe(false);
  });

  it('keeps a terse guideline that names no sibling', () => {
    const cursor = { name: '.cursorrules', content: 'Use tabs. Prefer small functions.' };
    expect(isPointerTo(cursor, [AGENTS, cursor])).toBe(false);
  });

  it('never treats a lone guideline as a pointer', () => {
    const only = { name: 'CLAUDE.md', content: 'See AGENTS.md' };
    expect(isPointerTo(only, [only])).toBe(false);
  });
});
