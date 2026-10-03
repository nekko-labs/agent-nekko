/**
 * Models that run on the phone itself. A short curated list rather than a
 * Hugging Face browser: each entry is a GGUF file we know the bundled
 * llama.cpp loads, sized for phones, with its exact byte size so the download
 * can be checked and the fit computed before a byte is fetched.
 */
export interface PhoneModel {
  id: string;
  name: string;
  family: string;
  /** Parameter count for display ("0.8B"). */
  params: string;
  blurb: string;
  repo: string;
  file: string;
  sizeBytes: number;
  /** Can reason before answering; we expose a thinking switch for these. */
  thinking?: boolean;
  /** Context window we open the model with on a phone (KV cache costs RAM). */
  ctx: number;
  license: string;
}

export const PHONE_MODELS: PhoneModel[] = [
  {
    id: 'qwen3.5-0.8b',
    name: 'Qwen3.5 0.8B',
    family: 'Qwen',
    params: '0.8B',
    blurb: 'Tiny and quick. Good for short answers, rewriting and quick questions on any phone.',
    repo: 'unsloth/Qwen3.5-0.8B-GGUF',
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    sizeBytes: 532_517_120,
    thinking: true,
    ctx: 4096,
    license: 'Apache 2.0',
  },
  {
    id: 'qwen3.5-2b',
    name: 'Qwen3.5 2B',
    family: 'Qwen',
    params: '2B',
    blurb: 'The everyday pick. Noticeably smarter than the tiny models and still fast.',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    sizeBytes: 1_280_835_840,
    thinking: true,
    ctx: 4096,
    license: 'Apache 2.0',
  },
  {
    id: 'gemma-4-e2b',
    name: 'Gemma 4 E2B',
    family: 'Gemma',
    params: 'E2B',
    blurb: "Google's on-device model. Strong writing and multilingual answers.",
    repo: 'unsloth/gemma-4-E2B-it-GGUF',
    file: 'gemma-4-E2B-it-Q4_K_M.gguf',
    sizeBytes: 3_106_738_272,
    ctx: 4096,
    license: 'Apache 2.0',
  },
  {
    id: 'qwen3.5-4b',
    name: 'Qwen3.5 4B',
    family: 'Qwen',
    params: '4B',
    blurb: 'The most capable model here for reasoning and code, on phones with 8 GB or more.',
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    sizeBytes: 2_740_937_888,
    thinking: true,
    ctx: 4096,
    license: 'Apache 2.0',
  },
  {
    id: 'gemma-4-e4b',
    name: 'Gemma 4 E4B',
    family: 'Gemma',
    params: 'E4B',
    blurb: 'Bigger Gemma for flagship phones. Best writing quality on the list.',
    repo: 'unsloth/gemma-4-E4B-it-GGUF',
    file: 'gemma-4-E4B-it-Q4_K_M.gguf',
    sizeBytes: 4_977_171_584,
    ctx: 4096,
    license: 'Apache 2.0',
  },
  {
    id: 'llama-3.2-1b',
    name: 'Llama 3.2 1B',
    family: 'Llama',
    params: '1B',
    blurb: 'A well-worn small model from Meta. Plain, predictable answers.',
    repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
    file: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
    sizeBytes: 807_694_464,
    ctx: 4096,
    license: 'Llama 3.2 Community',
  },
];

export function modelUrl(m: PhoneModel): string {
  return `https://huggingface.co/${m.repo}/resolve/main/${m.file}?download=true`;
}

export function findModel(id: string): PhoneModel | undefined {
  return PHONE_MODELS.find((m) => m.id === id);
}

export type Fit = 'great' | 'ok' | 'tight' | 'too-big';

/**
 * Will this model run well in this phone's memory? A loaded model costs about
 * its file size plus the KV cache and runtime (~0.6 GB at 4k context), and
 * iOS/Android only let one app use roughly half to two thirds of RAM before
 * killing it. Unknown RAM (web, odd devices) is treated as a mid-range phone.
 */
export function fitFor(m: PhoneModel, totalMemoryBytes: number | null | undefined): Fit {
  const ram = totalMemoryBytes && totalMemoryBytes > 0 ? totalMemoryBytes : 6 * GB;
  const need = m.sizeBytes + 0.6 * GB;
  if (need <= 0.35 * ram) return 'great';
  if (need <= 0.5 * ram) return 'ok';
  if (need <= 0.65 * ram) return 'tight';
  return 'too-big';
}

/**
 * The model we suggest first. The everyday 2B tier when it fits comfortably,
 * otherwise the tiny one: speed matters more than a few points of quality
 * when you're typing on a phone, so we never lead with the biggest that fits.
 */
export function recommendedModel(totalMemoryBytes: number | null | undefined): PhoneModel {
  const everyday = findModel('qwen3.5-2b')!;
  const fit = fitFor(everyday, totalMemoryBytes);
  return fit === 'great' || fit === 'ok' ? everyday : findModel('qwen3.5-0.8b')!;
}

export const GB = 1024 ** 3;

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
