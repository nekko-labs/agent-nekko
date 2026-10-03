/**
 * The slice of the host's IPC surface the phone uses. Types come straight from
 * `@agent-nekko/shared` (type-only, erased at build time, so Metro never
 * bundles the package); channel names are mirrored here as plain strings and
 * pinned to `IpcChannels` by `protocol.test.ts`.
 */
import type {
  AgentEvent,
  AskAnswer,
  AskRequest,
  ChatMessage,
  ModelInfo,
  PendingInput,
  ProviderConfig,
  SendOptions,
  Session,
  SessionSummary,
  ToolCall,
  WorkspaceFolder,
} from '@agent-nekko/shared';

export type {
  AgentEvent,
  AskAnswer,
  AskRequest,
  ChatMessage,
  ModelInfo,
  PendingInput,
  SendOptions,
  Session,
  SessionSummary,
  ToolCall,
  WorkspaceFolder,
};

export const Channels = {
  settingsGet: 'settings:get',
  providersList: 'providers:list',
  modelsList: 'models:list',
  sessionsSummaries: 'sessions:summaries',
  sessionCreate: 'session:create',
  sessionGet: 'session:get',
  sessionSetOptions: 'session:setOptions',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  chatQueue: 'chat:queue',
  chatPending: 'chat:pending',
  chatAnswer: 'chat:answer',
  toolApprove: 'tool:approve',
  workspaceList: 'workspace:list',
  appInfo: 'app:info',
} as const;

export const Events = {
  agentEvent: 'agent:event',
} as const;

/** A provider as the phone keeps it: never the API key or token reference. */
export type PublicProvider = Pick<ProviderConfig, 'id' | 'kind' | 'label' | 'enabled'>;

/**
 * `providers:list` returns provider records with their API keys in them. The
 * phone needs the id/label only, so strip everything else the moment the reply
 * arrives and never let a key reach state, storage or logs.
 */
export function publicProviders(list: unknown): PublicProvider[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is ProviderConfig => !!p && typeof p === 'object' && typeof (p as ProviderConfig).id === 'string')
    .map((p) => ({ id: p.id, kind: p.kind, label: p.label, enabled: !!p.enabled }));
}

/** What the chats list shows from a computer: real, top-level, unarchived chats. */
export function visibleSummaries(list: SessionSummary[]): SessionSummary[] {
  return list
    .filter((s) => !s.archivedAt && !s.parentSessionId && !s.taskId && !s.trainingRunId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The settings fields the phone reads (`settings:get` returns far more). */
export interface RemoteDefaults {
  defaultProviderId?: string;
  defaultModelId?: string;
  favoriteModels?: string[];
}

export function pickDefaults(settings: unknown): RemoteDefaults {
  const s = (settings ?? {}) as Record<string, unknown>;
  return {
    defaultProviderId: typeof s.defaultProviderId === 'string' ? s.defaultProviderId : undefined,
    defaultModelId: typeof s.defaultModelId === 'string' ? s.defaultModelId : undefined,
    favoriteModels: Array.isArray(s.favoriteModels) ? s.favoriteModels.filter((x) => typeof x === 'string') : undefined,
  };
}

/** `sendChat` errors unless the session names a concrete, enabled model. */
export const AUTO_MODEL_ID = '__auto__';
