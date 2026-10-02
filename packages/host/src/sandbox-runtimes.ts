import { execFile } from 'node:child_process';

export type SandboxRuntimeKind = 'apple-container' | 'docker' | 'podman' | 'orbstack';
export interface SandboxRuntimeStatus {
  kind: SandboxRuntimeKind;
  installed: boolean;
  ready: boolean;
  detail: string;
}
export type RuntimeProbe = (command: string, args: string[]) => Promise<string>;

const probe: RuntimeProbe = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout.trim());
  });
});

/** Discovery only: never starts a service, installs software, pulls images or creates a container. */
export async function discoverSandboxRuntimes(
  platform: NodeJS.Platform = process.platform,
  run: RuntimeProbe = probe,
): Promise<SandboxRuntimeStatus[]> {
  const candidates: Array<{ kind: SandboxRuntimeKind; command: string; version: string[]; health: string[] }> = [
    ...(platform === 'darwin' ? [{ kind: 'apple-container' as const, command: 'container', version: ['--version'], health: ['system', 'status'] }] : []),
    { kind: 'docker', command: 'docker', version: ['--version'], health: ['info', '--format', '{{.ServerVersion}}'] },
    { kind: 'podman', command: 'podman', version: ['--version'], health: ['info', '--format', '{{.Version.Version}}'] },
    ...(platform === 'darwin' ? [{ kind: 'orbstack' as const, command: 'orb', version: ['version'], health: ['status'] }] : []),
  ];
  return Promise.all(candidates.map(async (candidate) => {
    try { await run(candidate.command, candidate.version); }
    catch { return { kind: candidate.kind, installed: false, ready: false, detail: 'Not detected.' }; }
    try {
      const health = await run(candidate.command, candidate.health);
      // A successful CLI invocation alone is not evidence of a running engine.
      const ready = candidate.kind === 'apple-container' || candidate.kind === 'orbstack'
        ? /\brunning\b/i.test(health) && !/\bnot running\b/i.test(health)
        : /^\d+\.\d+(?:\.\d+)?/.test(health);
      return { kind: candidate.kind, installed: true, ready, detail: ready ? 'Service responded.' : 'Installed; service readiness is unverified.' };
    } catch {
      return { kind: candidate.kind, installed: true, ready: false, detail: 'Installed; service unavailable. Setup or start it with user consent.' };
    }
  }));
}
