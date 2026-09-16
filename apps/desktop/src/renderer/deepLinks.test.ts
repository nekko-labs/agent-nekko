import { describe, expect, it } from 'vitest';
import { hypergateConnectPort } from './deepLinks.js';

/**
 * The URL is the only thing another app controls, so a bad one has to be turned
 * away here. Everything downstream is read back from the daemon itself.
 */
describe('hypergateConnectPort', () => {
  it('reads the port out of a connect link', () => {
    expect(hypergateConnectPort('agent-nekko://hypergate/connect?port=7777')).toBe(7777);
    expect(hypergateConnectPort('agent-nekko://hypergate/connect?port=7999')).toBe(7999);
  });

  it('defaults to the daemon port when the link omits one', () => {
    expect(hypergateConnectPort('agent-nekko://hypergate/connect')).toBe(7777);
    expect(hypergateConnectPort('agent-nekko://hypergate/connect/')).toBe(7777);
  });

  it('rejects anything that is not an Agent Nekko connect link', () => {
    expect(hypergateConnectPort('https://hypergate.app/connect?port=7777')).toBeNull();
    expect(hypergateConnectPort('kotrain://hypergate/connect?port=7777')).toBeNull();
    expect(hypergateConnectPort('nekkos://hypergate/connect')).toBeNull();
    expect(hypergateConnectPort('agent-nekko://settings')).toBeNull();
    expect(hypergateConnectPort('agent-nekko://hypergate/disconnect')).toBeNull();
    expect(hypergateConnectPort('not a url at all')).toBeNull();
  });

  it('rejects a port that is not a port', () => {
    for (const bad of ['0', '-1', '70000', 'abc', '80.5', '']) {
      expect(hypergateConnectPort(`agent-nekko://hypergate/connect?port=${bad}`)).toBeNull();
    }
  });
});
