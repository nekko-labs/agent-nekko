import type { ModelInfo, ProviderConfig } from '@nekko-agent/shared';

export const modelPickerKey = (providerId: string, modelId: string) => `${providerId}::${modelId}`;

export function matchesModelQuery(model: Pick<ModelInfo, 'id' | 'name'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q);
}

export function filteredModelGroups(
  providers: ProviderConfig[],
  modelsOf: (providerId: string) => ModelInfo[],
  query: string,
): Array<{ provider: ProviderConfig; models: ModelInfo[] }> {
  return providers
    .map((provider) => ({ provider, models: modelsOf(provider.id).filter((model) => matchesModelQuery(model, query)) }))
    .filter((group) => group.models.length > 0);
}

export function nextFavoriteModels(current: readonly string[] | undefined, key: string): string[] {
  const next = new Set(current ?? []);
  next.has(key) ? next.delete(key) : next.add(key);
  return [...next];
}

type PickerTarget = EventTarget & {
  closest?: (selector: string) => unknown;
};

type PickerRoot = {
  contains?: (target: never) => boolean;
};

export function shouldDismissModelPickerPointer(
  target: EventTarget | null,
  triggerRoot: PickerRoot | null,
  popupRoot: PickerRoot | null,
): boolean {
  const element = target as PickerTarget | null;
  if (element?.closest?.('[role=menu]')) return false;
  if (target && triggerRoot?.contains?.(target as never)) return false;
  if (target && popupRoot?.contains?.(target as never)) return false;
  return true;
}

export function isModelPickerEscape(event: Pick<KeyboardEvent, 'key'>): boolean {
  return event.key === 'Escape';
}

