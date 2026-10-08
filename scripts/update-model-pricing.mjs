import { writeFile } from 'node:fs/promises';
const source = 'https://openrouter.ai/api/v1/models';
const response = await fetch(source);
if (!response.ok) throw new Error(`Pricing catalog returned ${response.status}`);
const { data } = await response.json();
const perMillion = value => Number((Number(value) * 1e6).toPrecision(12));
const price = p => ({ input: perMillion(p.prompt), output: perMillion(p.completion),
  ...(p.input_cache_read != null ? { cacheRead: Number(p.input_cache_read) * 1e6 } : {}),
  ...(p.input_cache_write != null ? { cacheWrite: Number(p.input_cache_write) * 1e6 } : {}) });
const models = data.filter(m => !m.id.startsWith('~') && !m.id.includes(':') && Number(m.pricing.prompt) >= 0 && Number(m.pricing.completion) >= 0).map(m => ({ id: m.id, ...price(m.pricing),
  ...(m.pricing.overrides ? { overrides: m.pricing.overrides.map(p => ({ minPromptTokens: p.min_prompt_tokens, ...price(p) })) } : {}) }));
if (!models.length || models.some(m => !Number.isFinite(m.input) || !Number.isFinite(m.output) || m.input < 0 || m.output < 0)) throw new Error('Invalid pricing catalog; snapshot not changed');
const snapshot = { source, checkedAt: new Date().toISOString().slice(0, 10), models };
await writeFile(new URL('../packages/shared/src/model-pricing-snapshot.ts', import.meta.url), '// Published standard text-token rates. Refresh with scripts/update-model-pricing.mjs.\nexport const MODEL_PRICING_SNAPSHOT = ' + JSON.stringify(snapshot, null, 2) + ' as const;\n');
console.log(`Saved ${models.length} published model rates`);
