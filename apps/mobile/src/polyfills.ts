/**
 * Runs before anything else (imported first by the root layout). The E2E
 * layer draws IVs from `crypto.getRandomValues`, which Hermes doesn't
 * provide; expo-crypto backs it with the platform's secure RNG.
 */
import { getRandomValues } from 'expo-crypto';

const g = globalThis as { crypto?: Partial<Crypto> };
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues as Crypto['getRandomValues'];
}
