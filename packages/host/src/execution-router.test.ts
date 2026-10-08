import { describe, it, expect, vi } from 'vitest';
import { getExecutionMode } from '@agent-nekko/shared';
import { executeSandboxTool, SANDBOX_TOOLS, sandboxWorkspaces } from './execution-router.js';
import { evaluateCapability, initialSandboxCapabilities } from './session-capabilities.js';

describe('sandbox fail-closed boundary', () => {
  it('explicit mode overrides legacy git isolation', () => {
    expect(getExecutionMode({ executionMode: 'sandbox', gitIsolation: true })).toBe('sandbox');
    expect(getExecutionMode({ executionMode: 'unified', gitIsolation: true })).toBe('unified');
    expect(getExecutionMode({ gitIsolation: false })).toBe('unified');
    expect(getExecutionMode({})).toBe('worktree');
  });
  it.each(['fetch_url', 'browser', 'capture', 'spawn_agent', 'delegation_targets', 'mcp_secret', 'start_process', 'agent_watch', 'complete_session', 'update_plan'])('denies %s without requesting a host grant', async name => {
    const approve = vi.fn();
    const result = await executeSandboxTool('missing', { id: 'call', name, input: {} }, approve);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('No host fallback');
    expect(approve).not.toHaveBeenCalled();
  });
  it('asks for even read operations and does not resolve host sessions after denial', async () => {
    const approve = vi.fn().mockResolvedValue(false);
    const result = await executeSandboxTool('missing', { id: 'call', name: 'read_file', input: { path: 'C:/secret' } }, approve);
    expect(result.output).toBe('Sandbox action not approved');
    expect(approve).toHaveBeenCalledOnce();
  });
  it('checks cancellation before approval', async () => {
    const approve = vi.fn(); const abort = new AbortController(); abort.abort();
    const result = await executeSandboxTool('missing', { id: 'call', name: 'bash', input: { command: 'echo secret' } }, approve, abort.signal);
    expect(result.isError).toBe(true); expect(approve).not.toHaveBeenCalled();
  });
  it('does not expose selected host folder paths to model context', () => {
    const workspaces = sandboxWorkspaces({ workspaceId: 'host-id', supportingWorkspaceIds: ['other-id'] } as any);
    expect(workspaces.map(w => w.path)).toEqual(['folder-0', 'folder-1']);
    expect(SANDBOX_TOOLS.has('fetch_url')).toBe(false);
  });
  it.each(['network:any', 'connector:any', 'mcp:any', 'app:any', 'tool:spawn_agent'])('denies unenforced %s even when granted', capability => {
    const context = initialSandboxCapabilities();
    context.runtimeReady = true; context.policy = 'yolo'; context.granted = new Set([capability as any]);
    expect(evaluateCapability(context, capability as any).action).toBe('deny');
  });
});
