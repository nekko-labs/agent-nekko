import type { ReadinessCatalog } from '@agent-nekko/shared';

/**
 * The versioned, curated component catalog for the offline PC-control stack.
 *
 * Curated means a human chose these entries and their budgets; versioned means
 * the whole catalog is stamped so a report can name the data it was computed
 * against. `artifact` pairs repo + file so the acquisition slice (AN9c) can
 * resolve a download; `sha256` is absent until hashes get pinned there, which
 * the evaluator reports as `artifact-unpinned` rather than inventing one.
 *
 * `memoryBytes` is the resident budget while running at the pinned
 * configuration (weights plus working set; for intent models, weights plus an
 * 8k-token KV plus server overhead), not the download size. `installBytes` is
 * the disk footprint.
 *
 * Order is curated preference: within a role, better picks come first and the
 * evaluator walks the list until one fits.
 */
const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** whisper.cpp's published language coverage (the 99-language set, trimmed to the common codes). */
const WHISPER_LANGS = [
  'en', 'zh', 'de', 'es', 'ru', 'ko', 'fr', 'ja', 'pt', 'tr', 'pl', 'ca', 'nl', 'ar', 'sv',
  'it', 'id', 'hi', 'fi', 'vi', 'he', 'uk', 'el', 'ms', 'cs', 'ro', 'da', 'hu', 'ta', 'no',
  'th', 'ur', 'hr', 'bg', 'lt', 'la', 'mi', 'ml', 'cy', 'sk', 'te', 'fa', 'lv', 'bn', 'sr',
  'az', 'sl', 'kn', 'et', 'mk', 'br', 'eu', 'is', 'hy', 'ne', 'mn', 'bs', 'kk', 'sq', 'sw',
  'gl', 'mr', 'pa', 'si', 'km', 'sn', 'yo', 'so', 'af', 'oc', 'ka', 'be', 'tg', 'sd', 'gu',
  'am', 'yi', 'lo', 'uz', 'fo', 'ht', 'ps', 'tk', 'nn', 'mt', 'sa', 'lb', 'my', 'bo', 'tl',
  'mg', 'as', 'tt', 'haw', 'ln', 'ha', 'ba', 'jw', 'su',
];

/** Kokoro v1's published language set. */
const KOKORO_LANGS = ['en', 'ja', 'zh', 'es', 'fr', 'hi', 'it', 'pt'];

export const OFFLINE_STACK_CATALOG: ReadinessCatalog = {
  version: '2026-09-11.1',
  entries: [
    // ---- Runtime: llama.cpp server builds per backend ----------------------
    {
      id: 'llama-server-cuda',
      role: 'runtime',
      name: 'llama.cpp server (CUDA)',
      languages: 'any',
      artifact: { repo: 'ggml-org/llama.cpp', file: 'llama-{ver}-bin-win-cuda-x64.zip', license: 'MIT' },
      installBytes: 400 * MB,
      memoryBytes: 300 * MB,
      requires: { os: ['win32', 'linux'], arch: ['x64'], backends: ['cuda'], cpuFeatures: ['avx2'] },
      recommended: { backends: ['cuda'] },
    },
    {
      id: 'llama-server-vulkan',
      role: 'runtime',
      name: 'llama.cpp server (Vulkan)',
      languages: 'any',
      artifact: { repo: 'ggml-org/llama.cpp', file: 'llama-{ver}-bin-win-vulkan-x64.zip', license: 'MIT' },
      installBytes: 350 * MB,
      memoryBytes: 300 * MB,
      requires: { os: ['win32', 'linux'], arch: ['x64'], backends: ['vulkan'], cpuFeatures: ['avx2'] },
      recommended: { backends: ['vulkan'] },
    },
    {
      id: 'llama-server-metal',
      role: 'runtime',
      name: 'llama.cpp server (Metal)',
      languages: 'any',
      artifact: { repo: 'ggml-org/llama.cpp', file: 'llama-{ver}-bin-macos-arm64.zip', license: 'MIT' },
      installBytes: 300 * MB,
      memoryBytes: 300 * MB,
      requires: { os: ['darwin'], arch: ['arm64'], backends: ['metal'] },
      recommended: { backends: ['metal'] },
    },
    {
      id: 'llama-server-cpu',
      role: 'runtime',
      name: 'llama.cpp server (portable CPU)',
      languages: 'any',
      artifact: { repo: 'ggml-org/llama.cpp', file: 'llama-{ver}-bin-{os}-{arch}.zip', license: 'MIT' },
      installBytes: 250 * MB,
      memoryBytes: 300 * MB,
      requires: { os: ['win32', 'linux', 'darwin'], arch: ['x64', 'arm64'] },
    },

    // ---- Intent LLM: GGUF weights the picked runtime serves ----------------
    {
      id: 'qwen25-14b-q4km',
      role: 'intent',
      name: 'Qwen2.5 14B Instruct (Q4_K_M)',
      languages: 'any',
      quantization: 'Q4_K_M',
      artifact: { repo: 'bartowski/Qwen2.5-14B-Instruct-GGUF', file: 'Qwen2.5-14B-Instruct-Q4_K_M.gguf', license: 'Apache-2.0' },
      installBytes: 9.0 * GB,
      memoryBytes: 11.5 * GB,
      prefersGpu: true,
      recommended: { minVramBytes: 12 * GB },
    },
    {
      id: 'llama31-8b-q4km',
      role: 'intent',
      name: 'Llama 3.1 8B Instruct (Q4_K_M)',
      languages: 'any',
      quantization: 'Q4_K_M',
      artifact: { repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', file: 'Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf', license: 'Llama-3.1-Community' },
      installBytes: 4.9 * GB,
      memoryBytes: 6.3 * GB,
      prefersGpu: true,
      recommended: { minVramBytes: 8 * GB },
    },
    {
      id: 'qwen25-7b-q4km',
      role: 'intent',
      name: 'Qwen2.5 7B Instruct (Q4_K_M)',
      languages: 'any',
      quantization: 'Q4_K_M',
      artifact: { repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', file: 'Qwen2.5-7B-Instruct-Q4_K_M.gguf', license: 'Apache-2.0' },
      installBytes: 4.7 * GB,
      memoryBytes: 6.0 * GB,
      prefersGpu: true,
      recommended: { minVramBytes: 8 * GB },
    },
    {
      id: 'qwen25-3b-q4km',
      role: 'intent',
      name: 'Qwen2.5 3B Instruct (Q4_K_M)',
      languages: 'any',
      quantization: 'Q4_K_M',
      artifact: { repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF', file: 'Qwen2.5-3B-Instruct-Q4_K_M.gguf', license: 'Apache-2.0' },
      installBytes: 2.0 * GB,
      memoryBytes: 2.8 * GB,
      prefersGpu: true,
      recommended: { minVramBytes: 4 * GB },
    },
    {
      id: 'qwen25-1.5b-q4km',
      role: 'intent',
      name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
      languages: 'any',
      quantization: 'Q4_K_M',
      artifact: { repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', file: 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf', license: 'Apache-2.0' },
      installBytes: 1.1 * GB,
      memoryBytes: 1.7 * GB,
      prefersGpu: true,
      recommended: { minVramBytes: 3 * GB },
      requires: { minRamBytes: 4 * GB },
    },

    // ---- STT: whisper.cpp ggml models + one Parakeet alternative -----------
    {
      id: 'whisper-small-en',
      role: 'stt',
      name: 'Whisper small.en',
      languages: ['en'],
      artifact: { repo: 'ggerganov/whisper.cpp', file: 'ggml-small.en.bin', license: 'MIT' },
      installBytes: 487 * MB,
      memoryBytes: 800 * MB,
      requires: { minRamBytes: 2 * GB },
    },
    {
      id: 'whisper-small-multi',
      role: 'stt',
      name: 'Whisper small (multilingual)',
      languages: WHISPER_LANGS,
      artifact: { repo: 'ggerganov/whisper.cpp', file: 'ggml-small.bin', license: 'MIT' },
      installBytes: 487 * MB,
      memoryBytes: 850 * MB,
      requires: { minRamBytes: 2 * GB },
    },
    {
      id: 'parakeet-tdt-v3',
      role: 'stt',
      name: 'Parakeet TDT 0.6B v3 (multilingual)',
      languages: ['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'nl', 'sv', 'da', 'no', 'fi', 'cs', 'sk', 'hr', 'bg', 'ro', 'uk', 'ru', 'el', 'et', 'lv', 'lt', 'sl', 'hu'],
      artifact: { repo: 'istupakov/parakeet-tdt-0.6b-v3-onnx', file: 'parakeet-tdt-0.6b-v3.onnx', license: 'CC-BY-4.0' },
      installBytes: 1.2 * GB,
      memoryBytes: 1.5 * GB,
      requires: { minRamBytes: 3 * GB },
    },
    {
      id: 'whisper-base-en',
      role: 'stt',
      name: 'Whisper base.en',
      languages: ['en'],
      artifact: { repo: 'ggerganov/whisper.cpp', file: 'ggml-base.en.bin', license: 'MIT' },
      installBytes: 148 * MB,
      memoryBytes: 300 * MB,
      requires: { minRamBytes: 1 * GB },
    },

    // ---- TTS: Piper voices + Kokoro for multi-language ---------------------
    {
      id: 'kokoro-82m',
      role: 'tts',
      name: 'Kokoro 82M (multilingual)',
      languages: KOKORO_LANGS,
      artifact: { repo: 'hexgrad/Kokoro-82M', file: 'kokoro-v1.0.onnx', license: 'Apache-2.0' },
      installBytes: 330 * MB,
      memoryBytes: 600 * MB,
      requires: { minRamBytes: 2 * GB },
    },
    {
      id: 'piper-amy-medium',
      role: 'tts',
      name: 'Piper en_US Amy (medium)',
      languages: ['en'],
      artifact: { repo: 'rhasspy/piper-voices', file: 'en/en_US/amy/medium/en_US-amy-medium.onnx', license: 'per-voice (see repo)' },
      installBytes: 63 * MB,
      memoryBytes: 200 * MB,
      requires: { minRamBytes: 1 * GB },
    },
    {
      id: 'piper-libritts-medium',
      role: 'tts',
      name: 'Piper en_US LibriTTS-R (medium)',
      languages: ['en'],
      artifact: { repo: 'rhasspy/piper-voices', file: 'en/en_US/libritts_r/medium/en_US-libritts_r-medium.onnx', license: 'per-voice (see repo)' },
      installBytes: 66 * MB,
      memoryBytes: 200 * MB,
      requires: { minRamBytes: 1 * GB },
    },
  ],
};
