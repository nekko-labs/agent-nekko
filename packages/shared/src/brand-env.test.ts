import { describe, expect, it } from 'vitest';
import { brandEnv, ENV_PREFIX, ENV_PREFIXES } from './brand-env.js';

describe('brandEnv', () => {
  it('advertises the current brand', () => {
    expect(ENV_PREFIX).toBe('NEKKO_');
    expect(ENV_PREFIXES).toEqual(['NEKKO_']);
  });

  it('reads the current name', () => {
    expect(brandEnv('TOKEN', { NEKKO_TOKEN: 'new' })).toBe('new');
  });

  it('does not read older brand prefixes', () => {
    expect(brandEnv('TOKEN', { KOTRAIN_TOKEN: 'k' })).toBeUndefined();
    expect(brandEnv('TOKEN', { NEKKOS_TOKEN: 'n' })).toBeUndefined();
    expect(brandEnv('TOKEN', { OPENPAW_TOKEN: 'o' })).toBeUndefined();
  });

  // An empty value is how a caller turns a default off, so it has to count
  // as set rather than fall through to a default.
  it('treats an empty value as set', () => {
    expect(brandEnv('URL', { NEKKO_URL: '' })).toBe('');
  });

  it('is undefined when not set', () => {
    expect(brandEnv('TOKEN', {})).toBeUndefined();
    expect(brandEnv('TOKEN', { UNRELATED_TOKEN: 'x' })).toBeUndefined();
  });
});
