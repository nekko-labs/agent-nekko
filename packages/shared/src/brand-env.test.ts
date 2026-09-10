import { describe, expect, it } from 'vitest';
import { brandEnv, ENV_PREFIX, ENV_PREFIXES } from './brand-env.js';

describe('brandEnv', () => {
  it('advertises the current brand first', () => {
    expect(ENV_PREFIX).toBe('NEKKO_');
    expect(ENV_PREFIXES[0]).toBe('NEKKO_');
  });

  it('reads the current name', () => {
    expect(brandEnv('TOKEN', { NEKKO_TOKEN: 'new' })).toBe('new');
  });

  it('falls back through every older brand', () => {
    expect(brandEnv('TOKEN', { KOTRAIN_TOKEN: 'k' })).toBe('k');
    expect(brandEnv('TOKEN', { NEKKOS_TOKEN: 'n' })).toBe('n');
    expect(brandEnv('TOKEN', { OPENPAW_TOKEN: 'o' })).toBe('o');
  });

  it('prefers the newest brand when several are set', () => {
    const env = { NEKKO_TOKEN: 'new', KOTRAIN_TOKEN: 'k', NEKKOS_TOKEN: 'n', OPENPAW_TOKEN: 'o' };
    expect(brandEnv('TOKEN', env)).toBe('new');
    expect(brandEnv('TOKEN', { KOTRAIN_TOKEN: 'k', OPENPAW_TOKEN: 'o' })).toBe('k');
  });

  // An empty value is how a caller turns a default off, so it has to win over
  // an older brand's non-empty value rather than falling through to it.
  it('treats an empty value as set', () => {
    expect(brandEnv('URL', { NEKKO_URL: '', KOTRAIN_URL: 'http://old' })).toBe('');
  });

  it('is undefined when no brand is set', () => {
    expect(brandEnv('TOKEN', {})).toBeUndefined();
    expect(brandEnv('TOKEN', { UNRELATED_TOKEN: 'x' })).toBeUndefined();
  });
});
