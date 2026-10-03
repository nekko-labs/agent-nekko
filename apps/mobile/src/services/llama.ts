/**
 * The on-device engine: llama.cpp through llama.rn, Metal on iPhone and
 * OpenCL/CPU on Android. One model is loaded at a time; loading another
 * releases the first, since two would not fit in a phone's memory.
 */
import { initLlama, releaseAllLlama, type LlamaContext } from 'llama.rn';

export const engineSupported = true;

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Engine {
  modelPath: string;
  gpu: boolean;
  /** Why the GPU isn't used, when it isn't (shown in model details). */
  gpuNote?: string;
  complete(
    messages: ChatTurn[],
    opts: { thinking: boolean; maxTokens: number },
    onDelta: (d: { content: string; reasoning: string }) => void,
  ): Promise<{ content: string; reasoning: string; tokensPerSecond?: number; interrupted: boolean }>;
  stop(): Promise<void>;
  release(): Promise<void>;
}

export async function loadEngine(modelPath: string, ctx: number, onProgress: (p: number) => void): Promise<Engine> {
  await releaseAllLlama();
  const context: LlamaContext = await initLlama(
    {
      model: modelPath,
      n_ctx: ctx,
      // Everything on the GPU when there is one; llama.cpp keeps it on the
      // CPU where Metal/OpenCL isn't available and says why.
      n_gpu_layers: 99,
      use_mlock: false,
      use_mmap: true,
      // Drop the oldest tokens instead of failing when a long chat fills the window.
      ctx_shift: true,
    },
    (p) => onProgress(Math.max(0, Math.min(1, p / 100))),
  );
  return {
    modelPath,
    gpu: context.gpu,
    gpuNote: context.gpu ? undefined : context.reasonNoGPU || undefined,
    async complete(messages, opts, onDelta) {
      let content = '';
      let reasoning = '';
      const result = await context.completion(
        {
          messages,
          n_predict: opts.maxTokens,
          enable_thinking: opts.thinking,
          reasoning_format: 'auto',
          temperature: 0.7,
          top_p: 0.9,
        },
        (t) => {
          // Parsed fields arrive cumulative; diff against what we've shown.
          const nextContent = t.content ?? content + (t.reasoning_content === undefined ? t.token : '');
          const nextReasoning = t.reasoning_content ?? reasoning;
          if (nextContent !== content || nextReasoning !== reasoning) {
            content = nextContent;
            reasoning = nextReasoning;
            onDelta({ content, reasoning });
          }
        },
      );
      const tps = result.timings?.predicted_per_second;
      return {
        content: result.content ?? result.text ?? content,
        reasoning: result.reasoning_content ?? reasoning,
        tokensPerSecond: typeof tps === 'number' && Number.isFinite(tps) ? tps : undefined,
        interrupted: !!result.interrupted,
      };
    },
    stop: () => context.stopCompletion(),
    release: () => context.release(),
  };
}
