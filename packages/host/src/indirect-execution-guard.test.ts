import { describe, expect, it, vi } from 'vitest';
vi.mock('@nekko-agent/shared', () => ({ getExecutionMode: (s?: { executionMode?: string }) => s?.executionMode ?? 'local' }));
vi.mock('./terminal.js', () => ({ appendAgentTerminal: vi.fn() }));
vi.mock('./sessions.js', () => ({ getSession: (id: string) => ({ executionMode: id === 'sandbox' ? 'sandbox' : 'local' }) }));
const { assertHostExecution } = await import('./indirect-execution-guard.js');
const { readFile, writeFile, listDir } = await import('./files.js');
const { startProcess } = await import('./processes.js');

describe('indirect host execution boundary', () => {
  it('denies sandbox and preserves normal and unscoped APIs', () => {
    expect(() => assertHostExecution('sandbox', 'MCP')).toThrow(/No host fallback/);
    expect(() => assertHostExecution('local', 'MCP')).not.toThrow();
    expect(() => assertHostExecution(undefined, 'File browser')).not.toThrow();
  });
  it('denies files before resolving or writing host paths', () => {
    expect(() => readFile('missing', 'sandbox')).toThrow(/sandbox/);
    expect(() => listDir('missing', 'sandbox')).toThrow(/sandbox/);
    expect(() => writeFile('missing', 'content', 'sandbox')).toThrow(/sandbox/);
  });
  it('denies background commands before spawning', () => {
    expect(() => startProcess({ sessionId: 'sandbox', command: 'exit 0', cwd: 'missing' })).toThrow(/sandbox/);
  });
});
