import { describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '@nekko-agent/shared';

const daemon = vi.fn();
vi.mock('./engine/daemon.js', () => ({ daemonCall: () => daemon }));

const { HYPERGATE_ENTRY_ID, callMcpTool, hypergateBase, hypergateEntry, mcpStatus, mcpToolSpecs, syncMcp, withHypergate } = await import('./mcp.js');

const INFO = { url: 'http://localhost:7777/mcp', token: 'tok', servers: 3, version: '0.22.0', port: 7777 };
const other = (id: string): McpServerConfig => ({ id, name: id, command: 'npx', args: [], enabled: true });

describe('hypergateBase', () => {
  it('defaults to the daemon port and honours an explicit one', () => {
    expect(hypergateBase()).toBe('http://localhost:7777');
    expect(hypergateBase(7999)).toBe('http://localhost:7999');
  });
});

describe('withHypergate', () => {
  it('appends the gateway when nothing is configured', () => {
    const next = withHypergate([], INFO);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(hypergateEntry(INFO));
    expect(next[0].enabled).toBe(true);
  });

  it('leaves other servers alone', () => {
    const next = withHypergate([other('files')], INFO);
    expect(next.map((s) => s.id)).toEqual(['files', HYPERGATE_ENTRY_ID]);
  });

  it('replaces the token in place on a re-connect, rather than adding a second row', () => {
    const first = withHypergate([], INFO);
    const next = withHypergate(first, { ...INFO, token: 'rotated' });
    expect(next).toHaveLength(1);
    expect(next[0].token).toBe('rotated');
  });

  it('keeps a name the user chose', () => {
    const renamed = withHypergate([], INFO).map((s) => ({ ...s, name: 'My gateway' }));
    expect(withHypergate(renamed, INFO)[0].name).toBe('My gateway');
  });

  it('keeps unrelated entries rather than dropping them', () => {
    const next = withHypergate([other('files')], INFO);
    expect(next.map((s) => s.id)).toEqual(['files', HYPERGATE_ENTRY_ID]);
  });
});

describe('MCP servers run by the engine daemon', () => {
  it('syncs through the daemon, keeps its snapshot for the tool list and status, and routes calls to it', async () => {
    const spec = { name: 'mcp__files__read', description: '(MCP) Read', parameters: { type: 'object', properties: {} } };
    daemon.mockImplementation(async (channel: string, arg: unknown) => {
      if (channel === 'daemon:info') return { owned: ['mcp:sync', 'mcp:call'] };
      if (channel === 'mcp:sync') return { specs: [spec], servers: { files: { connected: true, tools: [{ name: 'read', description: 'Read' }] } } };
      if (channel === 'mcp:call') return { toolCallId: (arg as { id: string }).id, output: 'contents' };
      throw new Error(channel);
    });
    const configs = [other('files'), { ...other('broken'), enabled: true }];
    await syncMcp(configs);
    expect(daemon).toHaveBeenCalledWith('mcp:sync', configs);
    expect(mcpToolSpecs()).toEqual([spec]);
    expect(mcpStatus(configs)).toEqual([
      { id: 'files', name: 'files', connected: true, tools: [{ name: 'read', description: 'Read' }], error: undefined },
      { id: 'broken', name: 'broken', connected: false, tools: [], error: undefined },
    ]);
    expect(await callMcpTool({ id: 'c1', name: 'mcp__files__read', input: {} })).toEqual({ toolCallId: 'c1', output: 'contents' });
    daemon.mockRejectedValueOnce(new Error('daemon gone'));
    expect(await callMcpTool({ id: 'c2', name: 'mcp__files__read', input: {} })).toMatchObject({ output: 'MCP call failed: daemon gone', isError: true });
  });
});
