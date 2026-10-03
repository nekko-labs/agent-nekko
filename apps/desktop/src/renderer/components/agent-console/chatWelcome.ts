/** Startup is already a turn, even before a live reply or saved message exists. */
export function chatWelcomeState({ messages, streaming, hasLive, hasProvider, modelId, imageMode }: {
  messages: number;
  streaming: boolean;
  hasLive: boolean;
  hasProvider: boolean;
  modelId: string | null;
  imageMode: boolean;
}): { welcome: boolean; modelChoice: boolean } {
  const welcome = messages === 0 && !streaming && !hasLive;
  return { welcome, modelChoice: welcome && hasProvider && (imageMode || !modelId) };
}
