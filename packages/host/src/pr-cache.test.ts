import { expect, it, vi } from 'vitest';
import { PrReadCache, githubReadCooldownMs } from './pr-cache.js';
it('deduplicates, caches and permits forced refresh', async () => {
  let now = 0;
  const cache = new PrReadCache(60000, () => now);
  const load = vi.fn(async () => null);
  await Promise.all([cache.get('pr', load), cache.get('pr', load, true)]);
  expect(load).toHaveBeenCalledTimes(1);
  now = 59000;
  await cache.get('pr', load);
  expect(load).toHaveBeenCalledTimes(1);
  now = 60000;
  await cache.get('pr', load);
  expect(load).toHaveBeenCalledTimes(2);
  await cache.get('pr', load, true);
  expect(load).toHaveBeenCalledTimes(3);
});
it('clears failed in-flight requests', async () => {
  const cache = new PrReadCache(60000);
  await expect(cache.get('pr', async () => { throw new Error('network'); })).rejects.toThrow('network');
  expect(await cache.get('pr', async () => 'ok')).toBe('ok');
});
it('distinguishes quota exhaustion from access errors', () => {
  expect(githubReadCooldownMs('GraphQL: API rate limit already exceeded for user ID 4411499.')).toBe(3600000);
  expect(githubReadCooldownMs('secondary rate limit')).toBe(60000);
  expect(githubReadCooldownMs('Resource not accessible')).toBe(0);
});
