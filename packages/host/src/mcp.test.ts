import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@agent-nekko/shared';
import { HYPERGATE_ENTRY_ID, hypergateBase, hypergateEntry, withHypergate } from './mcp.js';

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

  // The daemon was called KotrainMCP before the rename; two entries pointed at
  // one gateway would offer every tool twice.
  it('drops the pre-rename entry instead of leaving a duplicate', () => {
    const legacy: McpServerConfig = { ...other('kotrain-mcp'), url: INFO.url, token: 'old' };
    const next = withHypergate([legacy, other('files')], INFO);
    expect(next.map((s) => s.id)).toEqual(['files', HYPERGATE_ENTRY_ID]);
  });
});
