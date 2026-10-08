import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformPricingCatalog } from './update-model-pricing.mjs';
const pricing = () => ({ prompt: '0.000002', completion: '0.000004', input_cache_read: '0', input_cache_write: '0.000001' });
const transform = p => transformPricingCatalog([{ id: 'synthetic/model', pricing: p }], '2026-01-01');
test('synthetic catalog transforms cache and override rates without I/O', () => {
  const p = { ...pricing(), overrides: [{ ...pricing(), min_prompt_tokens: 0 }] };
  const before = JSON.stringify(p);
  assert.deepEqual(transform(p).models[0], { id: 'synthetic/model', input: 2, output: 4, cacheRead: 0, cacheWrite: 1, overrides: [{ minPromptTokens: 0, input: 2, output: 4, cacheRead: 0, cacheWrite: 1 }] });
  assert.equal(JSON.stringify(p), before);
});
for (const field of ['prompt', 'completion', 'input_cache_read', 'input_cache_write']) {
  for (const value of ['NaN', 'Infinity', '-1', '', ' ', Infinity, NaN, -1, true]) {
    test(`reject ${field}=${String(value)} on base and override`, () => {
      assert.throws(() => transform({ ...pricing(), [field]: value }), /Invalid pricing catalog/);
      assert.throws(() => transform({ ...pricing(), overrides: [{ ...pricing(), [field]: value, min_prompt_tokens: 10 }] }), /Invalid pricing catalog/);
    });
  }
}
for (const value of [NaN, Infinity, -1, 1.5, '10', null]) {
  test(`reject threshold ${String(value)}`, () => assert.throws(() => transform({ ...pricing(), overrides: [{ ...pricing(), min_prompt_tokens: value }] }), /Invalid pricing catalog/));
}
test('exclude nonstandard ids and reject empty catalog', () => {
  assert.throws(() => transformPricingCatalog([{ id: '~hidden', pricing: pricing() }, { id: 'model:variant', pricing: pricing() }], 'synthetic'), /Invalid pricing catalog/);
});
