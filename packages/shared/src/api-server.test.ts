import { describe, expect, it } from 'vitest';
import {
  apiServerBindHost,
  apiServerClientUrl,
  apiServerMcpConfig,
  apiServerRefusal,
  apiServerUrl,
  mcpServerEntry,
  withApiServerDefaults,
} from './api-server.js';

const base = withApiServerDefaults({ token: 't0k' });

describe('api server addresses', () => {
  it('is on by default, on loopback, with the default port', () => {
    expect(withApiServerDefaults(undefined)).toMatchObject({ enabled: true, bind: 'local', port: 1439 });
    expect(apiServerBindHost(base)).toBe('127.0.0.1');
    expect(apiServerUrl(base)).toBe('http://127.0.0.1:1439');
  });

  it('binds every interface for lan, but quotes an address someone can dial', () => {
    const lan = { ...base, bind: 'lan' as const };
    expect(apiServerBindHost(lan)).toBe('0.0.0.0');
    expect(apiServerUrl(lan, '192.168.1.5')).toBe('http://192.168.1.5:1439');
  });

  it('binds a custom host, bracketing IPv6', () => {
    expect(apiServerUrl({ ...base, bind: 'custom', host: '10.0.0.2' })).toBe('http://10.0.0.2:1439');
    expect(apiServerUrl({ ...base, bind: 'custom', host: '::1' })).toBe('http://[::1]:1439');
    // An empty custom host falls back to loopback rather than binding everything.
    expect(apiServerBindHost({ ...base, bind: 'custom', host: '' })).toBe('127.0.0.1');
  });

  it('hands clients the advertised address when there is one', () => {
    expect(apiServerClientUrl(base)).toBe('http://127.0.0.1:1439');
    expect(apiServerClientUrl({ ...base, advertisedUrl: 'http://nekko.tail.ts.net:9000/' })).toBe(
      'http://nekko.tail.ts.net:9000',
    );
  });

  it('refuses what it cannot serve safely', () => {
    expect(apiServerRefusal(base)).toBeNull();
    expect(apiServerRefusal({ ...base, token: '' })).toMatch(/token/i);
    expect(apiServerRefusal({ ...base, bind: 'custom', host: ' ' })).toMatch(/address/i);
    expect(apiServerRefusal({ ...base, advertisedUrl: 'nekko.local:1439' })).toMatch(/full URL/);
  });
});

describe('mcp entries', () => {
  it('is the portable npx form, with no env, when there is nothing to point at', () => {
    expect(mcpServerEntry('', '')).toEqual({ command: 'npx', args: ['-y', 'agent-nekko', 'mcp'] });
  });

  it('names the installed launcher and carries the address and token', () => {
    expect(mcpServerEntry('http://127.0.0.1:1439', 'abc', 'C:/bin/agent-nekko.cmd')).toEqual({
      command: 'C:/bin/agent-nekko.cmd',
      args: ['mcp'],
      env: { NEKKO_URL: 'http://127.0.0.1:1439', NEKKO_TOKEN: 'abc' },
    });
    expect(JSON.parse(apiServerMcpConfig('http://x:1', 'k')).mcpServers['agent-nekko'].env).toEqual({
      NEKKO_URL: 'http://x:1',
      NEKKO_TOKEN: 'k',
    });
  });
});
