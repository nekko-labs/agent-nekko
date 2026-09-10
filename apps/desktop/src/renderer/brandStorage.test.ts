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
  it('maps a dotted key onto every earlier brand', () => {
    expect(brandKeys('nekko.composerDrafts')).toEqual([
      'nekko.composerDrafts',
      'kotrain.composerDrafts',
      'nekkos.composerDrafts',
      'open-paw.composerDrafts',
    ]);
  });

  it('maps an underscored key too', () => {
    expect(brandKeys('nekko_token')).toEqual(['nekko_token', 'kotrain_token', 'nekkos_token', 'open-paw_token']);
  });
});

describe('readBrandKey', () => {
  it('prefers the current key', () => {
    const s = store({ 'nekko.x': 'new', 'kotrain.x': 'old' });
    expect(readBrandKey(s, 'nekko.x')).toBe('new');
  });

  it('adopts an earlier brand value and rewrites it under the current key', () => {
    const s = store({ 'kotrain.x': 'old' });
    expect(readBrandKey(s, 'nekko.x')).toBe('old');
    expect(s.map.get('nekko.x')).toBe('old');
    // The original stays, so a downgrade still finds its data.
    expect(s.map.get('kotrain.x')).toBe('old');
  });

  it('prefers the newest brand present', () => {
    const s = store({ 'kotrain.x': 'k', 'open-paw.x': 'o' });
    expect(readBrandKey(s, 'nekko.x')).toBe('k');
  });

  it('keeps an empty stored value rather than falling through', () => {
    const s = store({ 'nekko.x': '', 'kotrain.x': 'old' });
    expect(readBrandKey(s, 'nekko.x')).toBe('');
  });

  it('reads as absent when nothing is stored', () => {
    expect(readBrandKey(store(), 'nekko.x')).toBeNull();
  });

  it('reads as absent when storage throws', () => {
    expect(readBrandKey(store({ 'kotrain.x': 'old' }, true), 'nekko.x')).toBeNull();
  });
});
