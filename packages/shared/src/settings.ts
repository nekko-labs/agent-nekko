/** Persisted app settings + usage analytics record types. */

import type { ProviderConfig } from './models.js';
import type { GuardrailRule, SandboxMode } from './guardrails.js';
import type { WorkspaceFolder } from './workspace.js';
import type { ConnectorConfig } from './connectors.js';

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Brand accent. The default is an indigo-violet (paired in the UI with a cyan
 * secondary into a violet→cyan brand gradient, the modern developer-tool look).
 * `LEGACY_ACCENTS` are prior defaults we migrate off on load so users who never
 * customized the accent get the refreshed color, while anyone who picked their
 * own keeps it.
 */
export const DEFAULT_ACCENT = '#6d5efc';
export const LEGACY_ACCENTS = ['#ff7a59'];

/** A reusable prompt, invokable from the composer as `/name`. */
export interface PromptTemplate {
  id: string;
  name: string;
  body: string;
}

/** Built-in slash commands seeded for new installs. */
export const DEFAULT_PROMPTS: PromptTemplate[] = [
  { id: 'explain', name: 'explain', body: 'Explain how this code works, step by step.' },
  { id: 'review', name: 'review', body: 'Review this code for bugs, edge cases, and possible improvements.' },
  { id: 'test', name: 'test', body: 'Write tests for this code, covering the important edge cases.' },
  { id: 'fix', name: 'fix', body: 'Find and fix the bug. Explain the root cause and the fix.' },
  { id: 'refactor', name: 'refactor', body: 'Refactor this for clarity and simplicity without changing behavior.' },
];

/**
 * How hard the model should work on a turn. Providers translate this to their
 * own knob: a sampling temperature on models that still take one, and
 * `output_config.effort` on the Claude models that dropped sampling.
 */
export type EffortLevel = 'low' | 'normal' | 'high';

export const EFFORT_TEMPERATURE: Record<EffortLevel, number> = {
  low: 0.2,
  normal: 0.7,
  high: 1.0,
};

/**
 * Opt-in experimental surfaces. Each flag reveals a nav destination that stays
 * hidden until the user turns it on under Settings → Experimental. Undefined
 * means off: a flag that was never touched keeps its surface hidden.
 */
export interface ExperimentalFlags {
  /** The Training tab (data-scientist agent runs). */
  training?: boolean;
  /** The Design tab (sketch/describe-to-prototype board). */
  design?: boolean;
  /** The Memory tab (global + per-project memory). */
  memory?: boolean;
  /** Listen on 127.0.0.1 for inbound workflow webhooks. */
  workflowLoopbackListener?: boolean;
}

/**
 * First-run setup wizard state. `completedAt` is the "don't auto-show again"
 * flag: it is written whether the user finished or skipped setup, and cleared
 * by Settings → Replay setup. `version` lets a future step list re-prompt, and
 * `steps` records each step's outcome so a later version can tell finished
 * steps from skipped ones.
 */
export interface OnboardingState {
  version: number;
  completedAt?: number;
  steps?: Record<string, 'done' | 'skipped'>;
}

/** Bump when the wizard's steps change enough that existing users should see it again. */
export const ONBOARDING_VERSION = 1;

export interface AppSettings {
  theme: ThemeMode;
  accent: string;
  /** Secondary accent used for the brand gradient and border beam. */
  accent2?: string;
  /** Selected theme preset id (`system`, `nebula`, `terminal`, etc.). */
  themePreset?: string;
  sandboxMode: SandboxMode;
  providers: ProviderConfig[];
  guardrails: GuardrailRule[];
  workspaces: WorkspaceFolder[];
  connectors: ConnectorConfig[];
  defaultProviderId?: string;
  defaultModelId?: string;
  /** Show the mascot. */
  mascotEnabled: boolean;
  /** Sampling effort (temperature). */
  effort?: EffortLevel;
  /** Check for app updates automatically (desktop). */
  autoUpdate?: boolean;
  /** Whether we've shown the first-run "enable auto-update?" prompt. */
  autoUpdatePrompted?: boolean;
  /** UI language (BCP-47-ish code, e.g. "en", "es"). Undefined = follow system. */
  language?: string;
  /** Default tool-execution policy for new chats. */
  defaultChatMode?: import('./chat.js').ChatMode;
  /** Path to the shell new terminals launch by default (undefined = auto-detect). */
  defaultShellPath?: string;
  /** Reusable prompts invokable as `/name` in the composer. */
  prompts?: PromptTemplate[];
  /** Favorited models as `${providerId}::${modelId}`; sorted to the top. */
  favoriteModels?: string[];
  /** Configured MCP servers (stdio). */
  mcpServers?: import('./mcp.js').McpServerConfig[];
  /** Default spec-driven methodology id for new chats (see SPEC_METHODOLOGIES). */
  specMethodology?: string;
  /** Sub-agent orchestration strategy + bounds. */
  orchestration?: import('./orchestration.js').OrchestrationSettings;
  /**
   * Tool steps one reply may take before the agent wraps up (runaway-loop
   * backstop). Undefined = the core default. See MAX_STEPS_RANGE.
   */
  maxSteps?: number;
  /**
   * Tokens one model response may generate before the server cuts it off.
   * Undefined = MAX_OUTPUT_TOKENS_DEFAULT. See MAX_OUTPUT_TOKENS_RANGE.
   */
  maxOutputTokens?: number;
  /**
   * Which resource monitors run. Anything omitted falls back to
   * DEFAULT_MONITORS; a monitor switched off stops being sampled at all, so no
   * GPU-probe spawn and no CPU sampling happen for it.
   */
  monitors?: Partial<Record<import('./monitor.js').MonitorKind, boolean>>;
  /** Experimental feature toggles (Settings → Experimental). Off = surface hidden. */
  experimental?: ExperimentalFlags;
  /** First-run setup wizard progress (undefined on installs that predate it). */
  onboarding?: OnboardingState;
}

/**
 * Tool steps one reply may take before the agent wraps up. Real agentic work
 * (explore, edit, verify) routinely runs dozens of tool calls, so this is a
 * runaway-loop backstop rather than a work limit: reaching it makes the agent
 * answer with what it has instead of failing the reply.
 */
export const DEFAULT_MAX_STEPS = 80;

/** Bounds for the per-reply tool-step budget (Settings → Agent loop). */
export const MAX_STEPS_RANGE = { min: 5, max: 400 } as const;

/** Clamp a user-entered step budget into MAX_STEPS_RANGE (undefined = default). */
export function clampMaxSteps(n: number | undefined): number | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  return Math.min(MAX_STEPS_RANGE.max, Math.max(MAX_STEPS_RANGE.min, Math.round(n)));
}

/**
 * Tokens one model response may generate. Generous enough for a long answer or
 * a big file edit, low enough that a model which collapses into a loop stops on
 * its own within seconds rather than streaming until its context window fills.
 * Sent to every provider as its native output cap.
 */
export const MAX_OUTPUT_TOKENS_DEFAULT = 8_192;

/** Bounds for the per-response output cap (Settings → Agent loop). */
export const MAX_OUTPUT_TOKENS_RANGE = { min: 256, max: 200_000 } as const;

/** Clamp a user-entered output cap, falling back to the default. */
export function clampMaxOutputTokens(n: number | undefined): number {
  if (n == null || !Number.isFinite(n)) return MAX_OUTPUT_TOKENS_DEFAULT;
  return Math.min(MAX_OUTPUT_TOKENS_RANGE.max, Math.max(MAX_OUTPUT_TOKENS_RANGE.min, Math.round(n)));
}

/** One usage event appended to a JSONL log for analytics. */
export interface UsageRecord {
  ts: number;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  sessionId: string;
  /** Subscription providers bill the user through their plan, not per token. */
  auth?: 'apikey' | 'subscription';
}

export interface UsageSummary {
  totalInput: number;
  totalOutput: number;
  /** Estimated total spend (USD) over all recorded usage. */
  totalCost: number;
  byModel: Record<string, { input: number; output: number; cost?: number; subscription?: boolean }>;
  byProvider: Record<string, { input: number; output: number }>;
  /** Per-session token totals (keyed by sessionId) for per-chat cost. */
  bySession: Record<string, { input: number; output: number; cost?: number }>;
  /** Per-session estimated spend (USD), accurate to the model used per record. */
  bySessionCost: Record<string, number>;
  /** Daily buckets (YYYY-MM-DD → tokens + estimated cost) for the charts. */
  daily: Array<{ date: string; input: number; output: number; cost: number }>;
  /** True if any recorded usage came from a subscription provider. */
  hasSubscriptionUsage?: boolean;
}

/** Format a small USD amount for display. */
export function formatUSD(n: number): string {
  if (n <= 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}
