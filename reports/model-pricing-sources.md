# Cloud pricing sources and comparison policy

## Recommendation

Use OpenRouter's public model catalog as a bundled, dated snapshot for exact hosted-model API-equivalent token prices. It covers proprietary and open-weight models in one machine-readable feed. Prefer exact versioned IDs over historical family defaults. Keep local and subscription usage at zero incremental API spend, displaying equivalents separately.

Sources checked 2026-10-08:

- https://openrouter.ai/api/v1/models: machine-readable prompt, completion, cache and conditional prices. The checked-in snapshot contains 353 nonnegative standard model rates. Dynamic routers with -1 sentinel prices and batch aliases are excluded.
- https://developers.openai.com/api/docs/pricing: first-party API reference, useful for confirming direct-provider rates and long-context premiums.
- https://platform.claude.com/docs/en/about-claude/pricing: first-party Anthropic API reference.
- https://ollama.com/pricing: published cloud per-model rates and subscription credits. Useful alternative, but its prices are not interchangeable with OpenRouter routes. For example, GPT-OSS 120B is $0.15 input / $0.60 output per million tokens on Ollama, versus the catalog's $0.037 / $0.17 standard OpenRouter rates at this snapshot.

## Findings

The old Fable family entry used $3/$15, while the catalog lists Fable 5.1 at $10/$50, with $0.25 cached reads. Opus 5.5 is $4/$20; Sol 6.1 is $2/$10; exact-model pricing therefore matters even within a conceptual capability tier. This is not evidence that similarly grouped models have identical quality or prices.

## Tier policy

Fallback options group Fable/Astra, Opus/Sol, Sonnet, Haiku/Luna, and representative open models. These are convenience groupings requested by the user, not a benchmark-derived ranking. Exact model rates win. An unrecognized local model uses the user's selected fallback, or remains unpriced if disabled. Do not infer capability solely from parameter count, quantization or a filename. Unpriced subscription models do not inherit local fallbacks.

## Limitations

These are current standard text-token equivalents, not historical invoices. Routes, region, batch, tool fees and long-context premiums can differ. Aggregated token totals cannot determine per-request conditional premiums. The snapshot preserves conditional metadata but accounting uses standard rates and discloses that limitation. No model-use data is sent for pricing lookups; refresh is a maintenance script, not a background app request. Unknown GGUF filenames and fine-tunes require explicit identity mapping rather than substring guesses.

## Maintenance

Run `node scripts/update-model-pricing.mjs`, review the dated diff, build shared, and run pricing and usage regression tests. Confirm changes against first-party pricing when a direct-provider bill estimate matters. A comprehensive exact match for every local artifact is not possible without a trusted model identity record; keep unsupported identities honest rather than assigning a universal rate.
