import { describe, expect, it, vi } from 'vitest';
import { discoverSandboxRuntimes } from './sandbox-runtimes.js';

describe('sandbox runtime discovery', () => {
  it('distinguishes an installed client from an unavailable engine', async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === '--version') return 'Docker version 29.8.1';
      throw new Error('service unavailable');
    });
    const result = await discoverSandboxRuntimes('win32', run);
    expect(result.every((r) => r.installed && !r.ready)).toBe(true);
    expect(run.mock.calls.every(([, args]) => ['--version', 'info'].includes(args[0]))).toBe(true);
  });

  it('only offers Apple container and OrbStack on Macs and verifies readiness', async () => {
    const result = await discoverSandboxRuntimes('darwin', async (command, args) => {
      if (args[0] === 'info') return '29.8.1';
      return command === 'container' ? 'not running' : 'running';
    });
    expect(result.map((r) => r.kind)).toEqual(['apple-container', 'docker', 'podman', 'orbstack']);
    expect(result.find((r) => r.kind === 'apple-container')?.ready).toBe(false);
    expect(result.find((r) => r.kind === 'orbstack')?.ready).toBe(true);
  });

  it('does not claim readiness from empty output or install missing commands', async () => {
    const run = vi.fn(async (command: string) => {
      if (command === 'podman') throw new Error('ENOENT');
      return '';
    });
    const result = await discoverSandboxRuntimes('linux', run);
    expect(result.find((r) => r.kind === 'podman')).toMatchObject({ installed: false, ready: false });
    expect(result.every((r) => !r.ready)).toBe(true);
    expect(run.mock.calls.every(([command]) => ['docker', 'podman'].includes(command))).toBe(true);
  });
});
