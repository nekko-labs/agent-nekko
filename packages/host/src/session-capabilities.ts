/** Approval policy and isolation are independent. A permissive policy never grants host access. */
export type ExecutionEnvironment = 'normal' | 'sandboxed';
export type ApprovalPolicy = 'ask' | 'guardrails' | 'yolo';
export type SessionCapability =
  | `tool:${string}`
  | `connector:${string}`
  | `mcp:${string}`
  | `network:${string}`
  | `app:${string}`;

export interface SessionCapabilityContext {
  environment: ExecutionEnvironment;
  policy: ApprovalPolicy;
  runtimeReady: boolean;
  granted: ReadonlySet<SessionCapability>;
  connected: ReadonlySet<SessionCapability>;
}

export type CapabilityDecision =
  | { action: 'deny'; reason: string }
  | { action: 'request'; reason: string }
  | { action: 'allow' };

/** This is a policy seam, not an executor or proof of container isolation. */
export function evaluateCapability(
  context: SessionCapabilityContext,
  capability: SessionCapability,
  guardrail: 'allow' | 'ask' | 'deny' = 'allow',
): CapabilityDecision {
  if (context.environment === 'sandboxed') {
    if (!context.runtimeReady) return { action: 'deny', reason: 'Sandbox runtime is unavailable. Host fallback is forbidden.' };
    if (capability.startsWith('app:')) return { action: 'deny', reason: 'Sandboxed sessions cannot control host applications, including Nekko Agent.' };
    if (!context.granted.has(capability)) return { action: 'request', reason: 'This capability has not been provided to the isolated session.' };
  } else if (!context.connected.has(capability)) {
    return { action: 'request', reason: 'Connect this capability with user approval before using it.' };
  }
  if (guardrail === 'deny') return { action: 'deny', reason: 'Denied by a guardrail in every approval mode.' };
  if (context.policy === 'ask' || (context.policy === 'guardrails' && guardrail === 'ask')) {
    return { action: 'request', reason: 'This action requires user approval.' };
  }
  return { action: 'allow' };
}

/** First sandbox entry never inherits Normal-mode tools, apps, network or grants. */
export function initialSandboxCapabilities(): SessionCapabilityContext {
  return { environment: 'sandboxed', policy: 'ask', runtimeReady: false, granted: new Set(), connected: new Set() };
}
