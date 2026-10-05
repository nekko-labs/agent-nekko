import { describe, expect, it } from 'vitest';
import { fillTone } from './contextTone.js';

describe('fillTone', () => {
  it('stays grey with room, turns yellow near full and red when full', () => {
    expect(fillTone(10)).toBe('var(--ink-faint)');
    expect(fillTone(69.9)).toBe('var(--ink-faint)');
    expect(fillTone(70)).toBe('var(--warning)');
    expect(fillTone(89)).toBe('var(--warning)');
    expect(fillTone(90)).toBe('var(--danger)');
  });
});
