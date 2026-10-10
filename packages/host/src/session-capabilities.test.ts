import { describe, expect, it } from 'vitest';
import { evaluateCapability, initialSandboxCapabilities, type ApprovalPolicy, type SessionCapabilityContext } from './session-capabilities.js';

const context = (policy: ApprovalPolicy, patch: Partial<SessionCapabilityContext> = {}): SessionCapabilityContext => ({
  environment: 'sandboxed', policy, runtimeReady: true,
  granted: new Set(['tool:read_file']), connected: new Set(), ...patch,
});

describe('session capability contract', () => {
  it('starts isolated sessions in Ask with no capabilities or ready runtime', () => {
    const fresh = initialSandboxCapabilities();
    expect(fresh.policy).toBe('ask');
    expect(fresh.granted.size).toBe(0);
    expect(evaluateCapability(fresh, 'tool:read_file').action).toBe('deny');
  });

  for (const policy of ['ask', 'guardrails', 'yolo'] as const) {
    it(`${policy} never falls back to the host or controls host apps`, () => {
      expect(evaluateCapability(context(policy, { runtimeReady: false }), 'tool:read_file').action).toBe('deny');
      for (const app of ['app:agent-nekko', 'app:notepad'] as const) {
        expect(evaluateCapability(context(policy, { granted: new Set([app]) }), app).action).toBe('deny');
      }
    });
    it(`${policy} cannot use ungranted tools, connectors, MCP or network`, () => {
      for (const capability of ['tool:bash', 'connector:slack', 'mcp:filesystem', 'network:example.com'] as const) {
        expect(evaluateCapability(context(policy), capability).action).toBe('request');
      }
    });
    it(`${policy} respects deny guardrails even with a grant`, () => {
      expect(evaluateCapability(context(policy), 'tool:read_file', 'deny').action).toBe('deny');
    });
  }

  it('separates action approval from capability grants', () => {
    expect(evaluateCapability(context('ask'), 'tool:read_file').action).toBe('request');
    expect(evaluateCapability(context('guardrails'), 'tool:read_file').action).toBe('allow');
    expect(evaluateCapability(context('guardrails'), 'tool:read_file', 'ask').action).toBe('request');
    expect(evaluateCapability(context('yolo'), 'tool:read_file', 'ask').action).toBe('allow');
  });

  it('requires a connection in Normal, even for YOLO and self-control', () => {
    expect(evaluateCapability(context('yolo', { environment: 'normal' }), 'app:agent-nekko').action).toBe('request');
    expect(evaluateCapability(context('yolo', { environment: 'normal', connected: new Set(['app:agent-nekko']) }), 'app:agent-nekko').action).toBe('allow');
  });
});
