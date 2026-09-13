/**
 * Model auto-mode, a pure heuristic that picks the best available model for a
 * given prompt, with no extra model calls. "Best" means: match a strong model
 * to complex/coding work and a cheap/fast model to quick questions, among the
 * models the chat's provider actually exposes. Used by the ChatPane when the
 * user selects the ✨ Auto model option.
 *
 * Auto has three profiles (see `AutoQuality`) so "let Nekko pick" isn't a
 * single opaque policy: Cheap always reaches for the smallest capable model,
 * Quality always reaches for the strongest, and Normal reads the prompt and
 * picks between them. The pick is explained (not just returned) so the composer
 * can show which model the next message will run on, and why.
 */

import type { ModelInfo } from './models.js';

/** Sentinel model id meaning "let Nekko pick per turn". */
export const AUTO_MODEL_ID = '__auto__';

/** How aggressively Auto mode spends on capability. */
export type AutoQuality = 'cheap' | 'normal' | 'quality';

export const AUTO_QUALITIES: AutoQuality[] = ['cheap', 'normal', 'quality'];

/** Short labels + descriptions for the Auto profile picker. */
export const AUTO_QUALITY_META: Record<AutoQuality, { label: string; description: string }> = {
  cheap: { label: 'Cheap', description: 'Always the smallest capable model.' },
  normal: { label: 'Normal', description: 'Reads the prompt, picks to match.' },
  quality: { label: 'Quality', description: 'Always the strongest model available.' },
};

const COMPLEX_RE =
  /\b(implement|refactor|debug|architecture|design|migrat|optim[iy]|algorithm|concurren|distributed|security|performance|test|build|fix the|root cause|trace|why does|explain how)\b/i;

/** Heuristic: does this prompt warrant a stronger (pricier) model? */
export function isComplexPrompt(prompt: string): boolean {
  if (prompt.length > 600) return true;
  // Multi-step asks (numbered lists, several sentences) lean complex.
  if (/```/.test(prompt)) return true;
  return COMPLEX_RE.test(prompt);
}

/**
 * Models that aren't conversational: speech recognition, embeddings, rerankers,
 * text-to-speech, OCR, single-task models, and image generation. A local server
 * usually lists these alongside its chat models (LM Studio happily serves
 * `whisper-large-v3` and `unlimited-ocr` from the same endpoint), and picking one
 * for a reply just fails - so Auto never considers them. Matched on whole
 * name segments, and permissive on purpose: an unknown model is assumed to be a
 * chat model. Vision-language models are chat models and stay in.
 */
const NON_CHAT_RE =
  /(^|[\W_])(whisper|distil-whisper|parakeet|wav2vec|seamless|tts|piper|kokoro|bark|xtts|embed|embedding|bge|gte|e5|nomic-embed|minilm|jina-(embed|clip)|rerank|reranker|colbert|clip|siglip|sd|sdxl|sd3|stable-diffusion|flux|dall-e|dalle|ocr|trocr|paddle|florence|donut|layoutlm|translate|moderation|guard)([\W_]|$)/i;

/** Whether this model can hold a conversation (so Auto may pick it). */
export function isChatModel(model: ModelInfo): boolean {
  return !NON_CHAT_RE.test(`${model.id} ${model.name}`);
}

/**
 * Capability tier for a model, inferred from its id/name (higher = stronger).
 * Deliberately coarse, it only needs to rank what a provider offers.
 */
export function modelTier(model: ModelInfo): number {
  const id = `${model.id} ${model.name}`.toLowerCase();
  if (/opus|gpt-5|o1-pro|405b|70b|72b/.test(id)) return 5;
  if (/sonnet|gpt-4o(?!-mini)|gpt-4\.1(?!-mini)|o3(?!-mini)|o1(?!-mini)|llama-3\.[13]|qwen2?\.?5?-?(32|34)b|mixtral/.test(id)) return 4;
  if (/haiku|mini|flash|small|1\.5b|3b|7b|8b|9b|phi|gemma/.test(id)) return 2;
  return 3;
}

/** The model Auto settled on, plus enough context to explain the choice. */
export interface AutoPick {
  modelId: string;
  /** The chosen model's display name, for the composer chip. */
  name: string;
  /** One short sentence saying why this model, shown on hover. */
  reason: string;
  /** Inferred capability tier of the chosen model (see `modelTier`). */
  tier: number;
  /** Whether the prompt read as complex work (Normal profile only uses this). */
  complex: boolean;
}

/**
 * Resolve Auto mode to a concrete model, with the reasoning attached.
 *
 * Cheap and Quality ignore the prompt entirely (they're a standing instruction
 * about spend, and a picker that silently changes its mind is worse than one
 * that doesn't). Normal reads the prompt: complex work gets the strongest model
 * available, quick questions get the smallest capable one. "Capable" means tier
 * 2 and up, so Auto never drops onto a toy model when something better is
 * loaded. Ties break toward `preferred` (starred) ids, then list order.
 */
export function pickAutoModel(
  models: ModelInfo[],
  prompt: string,
  { quality = 'normal', preferred = new Set<string>() }: { quality?: AutoQuality; preferred?: Set<string> } = {},
): AutoPick | null {
  if (models.length === 0) return null;
  // Speech, embedding, and image models can't answer a chat turn. Fall back to
  // the raw list only if filtering would leave nothing to pick from.
  const chatOnly = models.filter(isChatModel);
  const candidates = chatOnly.length ? chatOnly : models;

  const complex = isComplexPrompt(prompt);
  // Normal is the only profile that lets the prompt move the target.
  const wantStrong = quality === 'quality' || (quality === 'normal' && complex);

  const ranked = candidates
    .map((m, i) => ({ m, tier: modelTier(m), i, fav: preferred.has(m.id) ? 0 : 1 }))
    .sort((a, b) => {
      const byTier = wantStrong ? b.tier - a.tier : a.tier - b.tier;
      return byTier || a.fav - b.fav || a.i - b.i;
    });

  // Reaching down for a cheap model shouldn't land below tier 2 when something
  // more capable is available.
  const capable = ranked.filter((r) => r.tier >= 2);
  const chosen = (!wantStrong && capable.length ? capable[0] : ranked[0]);

  return {
    modelId: chosen.m.id,
    name: chosen.m.name || chosen.m.id,
    tier: chosen.tier,
    complex,
    reason: autoReason(quality, complex, candidates.length),
  };
}

function autoReason(quality: AutoQuality, complex: boolean, count: number): string {
  if (count === 1) return 'The only model this provider offers.';
  if (quality === 'cheap') return 'Cheap: the smallest model that can still do the job.';
  if (quality === 'quality') return 'Quality: the strongest model available, whatever you ask.';
  return complex
    ? 'This reads like real work, so Auto reached for the strongest model.'
    : 'A quick question, so Auto picked a smaller, faster model.';
}

/**
 * Pick a concrete model id for a prompt from the available list. Thin wrapper
 * over `pickAutoModel` for callers that only want the id. Returns null only
 * when there are no models.
 */
export function recommendModel(
  models: ModelInfo[],
  prompt: string,
  preferred: Set<string> = new Set(),
  quality: AutoQuality = 'normal',
): string | null {
  return pickAutoModel(models, prompt, { quality, preferred })?.modelId ?? null;
}
