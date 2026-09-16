import { describe, expect, it } from 'vitest';
import { brandKeys, readBrandKey } from './brandStorage.js';

function store(initial: Record<string, string> = {}, broken = false) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => {
      if (broken) throw new Error('blocked');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (broken) throw new Error('blocked');
      map.set(k, v);
    },
  };
}

describe('brandKeys', () => {
  it('returns just the key', () => {
    expect(brandKeys('nekko.composerDrafts')).toEqual(['nekko.composerDrafts']);
    expect(brandKeys('nekko_token')).toEqual(['nekko_token']);
  });
});

describe('readBrandKey', () => {
  it('reads the key', () => {
    const s = store({ 'nekko.x': 'new' });
    expect(readBrandKey(s, 'nekko.x')).toBe('new');
  });

  it('does not read earlier brand keys', () => {
    const s = store({ 'kotrain.x': 'old' });
    expect(readBrandKey(s, 'nekko.x')).toBeNull();
  });

  it('keeps an empty stored value rather than reading as absent', () => {
    const s = store({ 'nekko.x': '' });
    expect(readBrandKey(s, 'nekko.x')).toBe('');
  });

  it('reads as absent when nothing is stored', () => {
    expect(readBrandKey(store(), 'nekko.x')).toBeNull();
  });

  it('reads as absent when storage throws', () => {
    expect(readBrandKey(store({ 'nekko.x': 'x' }, true), 'nekko.x')).toBeNull();
  });
});
