import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const source = 'https://openrouter.ai/api/v1/models';

// Pure transformation: callers supply the catalog and date, with no I/O.
export function transformPricingCatalog(data, checkedAt) {
  const invalid = () => { throw new Error('Invalid pricing catalog; snapshot not changed'); };
  const rate = value => {
    if (value == null || (typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) invalid();
    const n = Number((Number(value) * 1e6).toPrecision(12));
    if (!Number.isFinite(n) || n < 0) invalid();
    return n;
  };
  const price = p => ({ input: rate(p.prompt), output: rate(p.completion),
    ...(p.input_cache_read != null ? { cacheRead: rate(p.input_cache_read) } : {}),
    ...(p.input_cache_write != null ? { cacheWrite: rate(p.input_cache_write) } : {}) });
  if (!Array.isArray(data)) invalid();
  const models = data.filter(m => {
    if (typeof m?.id !== 'string') invalid();
    return !m.id.startsWith('~') && !m.id.includes(':');
  }).map(m => ({ id: m.id, ...price(m.pricing),
    ...(m.pricing.overrides != null ? { overrides: m.pricing.overrides.map(p => {
      if (!Number.isFinite(p.min_prompt_tokens) || !Number.isInteger(p.min_prompt_tokens) || p.min_prompt_tokens < 0) invalid();
      return { minPromptTokens: p.min_prompt_tokens, ...price(p) };
    }) } : {}) }));
  if (!models.length) invalid();
  return { source, checkedAt, models };
}

async function main() {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Pricing catalog returned ${response.status}`);
  const { data } = await response.json();
  const snapshot = transformPricingCatalog(data, new Date().toISOString().slice(0, 10));
  await writeFile(new URL('../packages/shared/src/model-pricing-snapshot.ts', import.meta.url), '// Published standard text-token rates. Refresh with scripts/update-model-pricing.mjs.\nexport const MODEL_PRICING_SNAPSHOT = ' + JSON.stringify(snapshot, null, 2) + ' as const;\n');
  console.log(`Saved ${snapshot.models.length} published model rates`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
