import type { CatalogModel, EngineMemory, GpuFit, LocalModel } from '@agent-nekko/shared';

export type LibraryModel = LocalModel & { loaded: boolean; gpuFit?: GpuFit };
export interface ModelFamily {
  key: string;
  name: string;
  local: LibraryModel[];
  catalog: CatalogModel[];
}

export function modelFamilyName(value: string): string {
  return value.split('/').pop()!
    .replace(/\.gguf$/i, '')
    .replace(/[-_. ](?:GGUF|GGML|MLX|[248]bit|(?:I?Q\d[\w]*|BF16|FP16|F16|FP32|F32))(?:[-_. ]|$)/gi, '-')
    .replace(/[-_. ](?:GGUF|GGML|MLX|[248]bit|I?Q\d[\w]*|BF16|FP16|F16|FP32|F32)$/gi, '')
    .replace(/[-_. ]+$/, '')
    .replace(/[ _]+/g, '-');
}

export function groupModelFamilies(local: LibraryModel[], catalog: CatalogModel[]): ModelFamily[] {
  const groups = new Map<string, ModelFamily>();
  const get = (name: string) => {
    const label = modelFamilyName(name);
    const key = label.toLowerCase().replace(/[-_. ]/g, '');
    let group = groups.get(key);
    if (!group) { group = { key, name: label, local: [], catalog: [] }; groups.set(key, group); }
    return group;
  };
  for (const m of catalog) get(m.baseModel || m.name || m.id).catalog.push(m);
  for (const m of local) {
    const repo = catalog.find(c => c.id === m.sourceRepo);
    get(repo?.baseModel || m.sourceRepo || m.name).local.push(m);
  }
  return [...groups.values()].sort((a, b) => Number(b.local.length > 0) - Number(a.local.length > 0) || a.name.localeCompare(b.name));
}

export function gpuGuidance(sizeBytes: number | undefined, memory?: EngineMemory, model?: LibraryModel): string {
  if (model?.gpuFit === 'cpu' || memory?.kind === 'ram') return 'CPU only';
  if (model?.gpuFit === 'wont' || model?.gpuFit === 'partial') return 'Too big';
  if (model?.gpuFit === 'full') {
    return model.maxContext && model.preset?.contextTokens && model.preset.contextTokens < model.maxContext
      ? 'Fits on GPU, but limited context size' : 'Fits on GPU';
  }
  if (!sizeBytes || !memory?.budgetBytes) return 'GPU fit unknown';
  if (sizeBytes * 1.2 <= memory.budgetBytes * 0.55) return 'Fits on GPU';
  if (sizeBytes * 1.2 <= memory.budgetBytes * 0.85) return 'Fits on GPU, but limited context size';
  return 'Too big';
}
