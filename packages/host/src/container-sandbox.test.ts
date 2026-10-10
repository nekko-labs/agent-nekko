import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ContainerSandbox, type SandboxRunner, type SnapshotFile } from './container-sandbox.js';

const image = `example/sandbox@sha256:${'a'.repeat(64)}`;
const imageId = `sha256:${'b'.repeat(64)}`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'nekko-container-')); dirs.push(dir);
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'a.txt'), 'original');
  const calls: string[][] = []; const files = new Map<string, SnapshotFile>();
  let token = ''; let container = ''; let volume = ''; let badIdentity = false;
  const file = (p: string, text: string): SnapshotFile => ({ path: p, base64: Buffer.from(text).toString('base64'), hash: createHash('sha256').update(text).digest('hex') });
  const run: SandboxRunner = async (_exe, args, options) => {
    expect(options.windowsHide).toBe(true); calls.push(args);
    let result: unknown = '';
    if (args[0] === 'info') result = { OSType: 'linux', ServerVersion: '29.0.0' };
    if (args[0] === 'image') result = [{ Os: 'linux', Id: imageId }];
    if (args[0] === 'create') {
      container = args[args.indexOf('--name') + 1]; token = container.slice(6);
      volume = `nekko-${token}-workspace`;
    }
    if (args[0] === 'container' && args[1] === 'ls') result = JSON.stringify(container);
    if (args[0] === 'volume' && args[1] === 'ls') result = volume;
    if (args[0] === 'inspect') result = [{ Image: imageId, State: { Running: true }, Config: { User: '1000:1000', Labels: { 'dev.nekko.sandbox': badIdentity ? 'other' : token } }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' }, PidsLimit: 128, NanoCpus: 1000000000 }, Mounts: [{ Type: 'volume', Name: volume, Destination: '/workspace', RW: true }] }];
    if (args[0] === 'volume' && args[1] === 'inspect') result = [{ Labels: { 'dev.nekko.sandbox': token } }];
    if (args[0] === 'exec' && args.includes('-c') && args.at(-1)?.startsWith('{')) {
      const q = JSON.parse(args.at(-1)!);
      if (q.op === 'write') { const b = Buffer.from(q.base64, 'base64'); files.set(q.path, { path: q.path, base64: q.base64, hash: createHash('sha256').update(b).digest('hex') }); result = { written: q.path }; }
      if (q.op === 'snapshot') result = [...files.values()];
      if (q.op === 'read') result = { base64: files.get(q.path)?.base64 };
      if (q.op === 'list') result = [...files.keys()];
    }
    return { stdout: typeof result === 'string' ? result : JSON.stringify(result), stderr: '' };
  };
  const config = { sessionId: 'session', stateDirectory: path.join(dir, 'state'), sourceFolders: [source], image };
  return { dir, source, config, calls, run, files, file, badIdentity: () => { badIdentity = true; }, sandbox: new ContainerSandbox(config, run) };
}

it.skipIf(!process.env.NEKKO_SANDBOX_TEST_IMAGE)('real preinstalled Docker image lifecycle and executor', async () => {
  const f = fixture();
  const sandbox = new ContainerSandbox({ ...f.config, sessionId: 'real-test', image: process.env.NEKKO_SANDBOX_TEST_IMAGE! });
  await sandbox.initialize();
  try {
    expect(await sandbox.execute('read_file', { path: 'folder-0/a.txt' })).toBe('original');
    await sandbox.execute('write_file', { path: 'folder-0/large.txt', content: 'x'.repeat(50000) });
    expect(await sandbox.execute('read_file', { path: 'folder-0/large.txt' })).toBe('x'.repeat(50000));
    await sandbox.execute('write_file', { path: 'folder-0/b.txt', content: 'hello' });
    await sandbox.execute('edit_file', { path: 'folder-0/b.txt', old_string: 'hello', new_string: 'world' });
    expect(await sandbox.execute('read_file', { path: 'folder-0/b.txt' })).toBe('world');
    expect(await sandbox.execute('list_dir', {})).toContain('folder-0/a.txt');
    expect(await sandbox.execute('glob', { pattern: '*.txt' })).toContain('folder-0/b.txt');
    expect(await sandbox.execute('grep', { pattern: 'world' })).toEqual([{ path: 'folder-0/b.txt', line: 1, text: 'world' }]);
    const shell = await sandbox.execute('bash', { command: 'id -u; printf shell > folder-0/a.txt' }) as { stdout: string };
    expect(shell.stdout.trim()).toBe('1000');
    await expect(sandbox.applyBack(await sandbox.diff())).rejects.toThrow('Apply-back is disabled');
    expect(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8')).toBe('original');
    expect(fs.existsSync(path.join(f.source, 'b.txt'))).toBe(false);
    await sandbox.execute('bash', { command: 'ln -s /etc/passwd folder-0/alias' });
    await expect(sandbox.snapshot()).rejects.toThrow();
    await sandbox.execute('bash', { command: 'rm folder-0/alias' });
    // Killing the owned container cancels the shell itself, not only docker exec.
    const manifest = JSON.parse(fs.readFileSync(path.join(f.config.stateDirectory, 'real-test.sandbox.json'), 'utf8'));
    const running = sandbox.execute('bash', { command: 'sleep 30; printf leaked > folder-0/cancelled.txt' });
    const rejected = expect(running).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 500));
    const { defaultSandboxRunner } = await import('./container-sandbox.js');
    await defaultSandboxRunner('C:/Program Files/Docker/Docker/resources/bin/docker.exe', ['kill', manifest.container], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    await rejected;
    await defaultSandboxRunner('C:/Program Files/Docker/Docker/resources/bin/docker.exe', ['start', manifest.container], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    expect(await sandbox.execute('glob', { pattern: '*cancelled*' })).toEqual([]);
  } finally { await sandbox.destroy(); }
}, 60000);

describe('container sandbox', () => {
  it('requires explicit digest pinning', () => {
    const f = fixture(); expect(() => new ContainerSandbox({ ...f.config, image: 'python:latest' }, f.run)).toThrow('digest');
  });
  it('copies only selected plain files and persists/reuses identity without pulling', async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.source, '.git')); fs.writeFileSync(path.join(f.source, '.git', 'secret'), 'secret');
    fs.mkdirSync(path.join(f.source, 'node_modules')); fs.writeFileSync(path.join(f.source, '.env.local'), 'secret');
    await f.sandbox.initialize();
    expect([...f.files.keys()]).toEqual(['folder-0/a.txt']);
    const create = f.calls.find((c) => c[0] === 'create')!;
    for (const arg of ['--pull=never', '--read-only', '--network', 'none', '--cap-drop', 'ALL', 'no-new-privileges', '--tmpfs', '--memory', '--cpus', '--pids-limit']) expect(create).toContain(arg);
    expect(create.join(' ')).not.toContain(f.source);
    const count = f.calls.length;
    const resumed = new ContainerSandbox(f.config, f.run); await resumed.initialize();
    expect(f.calls.slice(count).some((c) => c[0] === 'create')).toBe(false);
    expect(await resumed.execute('read_file', { path: 'folder-0/a.txt' })).toBe('original');
    expect(f.calls.every((c) => !['pull', 'service'].includes(c[0]))).toBe(true);
    await resumed.destroy(); expect(f.calls.some((c) => c[0] === 'rm')).toBe(true);
  });
  it('cleans up a partial creation with only its owned volume present', async () => {
    const f = fixture();
    const run: SandboxRunner = async (exe, args, options) => {
      if (args[0] === 'create') throw new Error('creation interrupted');
      if (args[0] === 'container' && args[1] === 'ls') return { stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'ls') {
        const m = JSON.parse(fs.readFileSync(path.join(f.config.stateDirectory, 'session.sandbox.json'), 'utf8'));
        return { stdout: m.volume, stderr: '' };
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        const m = JSON.parse(fs.readFileSync(path.join(f.config.stateDirectory, 'session.sandbox.json'), 'utf8'));
        return { stdout: JSON.stringify([{ Labels: { 'dev.nekko.sandbox': m.token } }]), stderr: '' };
      }
      return f.run(exe, args, options);
    };
    await expect(new ContainerSandbox(f.config, run).initialize()).rejects.toThrow('interrupted');
    await new ContainerSandbox(f.config, run).destroy();
    expect(f.calls.some(c => c[0] === 'volume' && c[1] === 'rm')).toBe(true);
    expect(f.calls.some(c => c[0] === 'rm')).toBe(false);
  });
  it('cleans up stopped resources after restart without touching source files', async () => {
    const f = fixture(); await f.sandbox.initialize();
    const run: SandboxRunner = async (exe, args, options) => {
      const result = await f.run(exe, args, options);
      if (args[0] === 'inspect') {
        const containers = JSON.parse(result.stdout); containers[0].State.Running = false;
        return { ...result, stdout: JSON.stringify(containers) };
      }
      return result;
    };
    await new ContainerSandbox(f.config, run).destroy();
    expect(f.calls.some(c => c[0] === 'rm')).toBe(true);
    expect(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8')).toBe('original');
  });
  it('fails closed for non-Linux or unavailable engine and missing image', async () => {
    for (const mode of ['windows', 'offline', 'missing']) {
      const f = fixture();
      const run: SandboxRunner = async (exe, args, opts) => {
        if (args[0] === 'info') {
          if (mode === 'offline') throw new Error('engine unavailable');
          if (mode === 'windows') return { stdout: JSON.stringify({ OSType: 'windows', ServerVersion: '29' }), stderr: '' };
        }
        if (mode === 'missing' && args[0] === 'image') throw new Error('image unavailable');
        return f.run(exe, args, opts);
      };
      await expect(new ContainerSandbox(f.config, run).initialize()).rejects.toThrow();
      expect(f.calls.some((c) => c[0] === 'create')).toBe(false);
    }
  });
  it('rejects source hardlinks and size/count overflow before creating containers', async () => {
    const f = fixture(); fs.linkSync(path.join(f.source, 'a.txt'), path.join(f.source, 'alias.txt'));
    await expect(f.sandbox.initialize()).rejects.toThrow('Links');
    expect(f.calls.some((c) => c[0] === 'create')).toBe(false);
    fs.unlinkSync(path.join(f.source, 'alias.txt'));
    await expect(new ContainerSandbox({ ...f.config, limits: { bytes: 2 } }, f.run).initialize()).rejects.toThrow('limit');
    fs.writeFileSync(path.join(f.source, 'b.txt'), 'b');
    await expect(new ContainerSandbox({ ...f.config, limits: { files: 1 } }, f.run).initialize()).rejects.toThrow('limit');
  });
  it('rejects unsupported tools and traversal without host execution', async () => {
    const f = fixture(); await f.sandbox.initialize(); const count = f.calls.length;
    await expect(f.sandbox.execute('start_process', { command: 'echo host' })).rejects.toThrow('Unsupported');
    expect(f.calls.length).toBe(count);
    for (const p of ['../outside', '/absolute', 'folder-0/../x', 'folder-0/.env', 'C:\\x', 'folder-0/NUL', 'folder-0/x.']) await expect(f.sandbox.execute('write_file', { path: p, content: 'bad' })).rejects.toThrow('Unsafe');
    await f.sandbox.execute('bash', { command: 'echo "a & b"' });
    expect(f.calls.at(-1)).toEqual(['exec', '--user', '1000:1000', '--workdir', '/workspace', expect.any(String), '/bin/sh', '-c', 'echo "a & b"']);
  });
  it('rejects container identity mismatch', async () => {
    const f = fixture(); await f.sandbox.initialize(); f.badIdentity();
    await expect(f.sandbox.snapshot()).rejects.toThrow('isolation');
    await expect(f.sandbox.destroy()).rejects.toThrow('identity');
    expect(f.calls.some(c => c[0] === 'rm')).toBe(false);
  });
  it('validates hostile exports, collisions and hashes before host writes', async () => {
    const f = fixture(); await f.sandbox.initialize();
    f.files.set('evil', f.file('../outside', 'bad'));
    await expect(f.sandbox.snapshot()).rejects.toThrow('Unsafe'); f.files.delete('evil');
    f.files.set('collision', f.file('folder-0/A.TXT', 'bad'));
    await expect(f.sandbox.snapshot()).rejects.toThrow('Invalid'); f.files.delete('collision');
    f.files.set('folder-0/a.txt', { ...f.file('folder-0/a.txt', 'new'), hash: 'fake' });
    await expect(f.sandbox.snapshot()).rejects.toThrow('hash');
    expect(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8')).toBe('original');
  });
  it('denies additions, replacements and deletions without touching external host edits', async () => {
    const f = fixture(); await f.sandbox.initialize();
    f.files.set('folder-0/a.txt', f.file('folder-0/a.txt', 'sandbox edit'));
    f.files.set('folder-0/new.txt', f.file('folder-0/new.txt', 'new'));
    const changes = await f.sandbox.diff();
    fs.writeFileSync(path.join(f.source, 'a.txt'), 'external edit');
    await expect(f.sandbox.applyBack(changes)).rejects.toThrow('Apply-back is disabled');
    expect(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8')).toBe('external edit');
    expect(fs.existsSync(path.join(f.source, 'new.txt'))).toBe(false);
    f.files.delete('folder-0/a.txt');
    await expect(f.sandbox.applyBack(await f.sandbox.diff())).rejects.toThrow('Apply-back is disabled');
    expect(fs.readFileSync(path.join(f.source, 'a.txt'), 'utf8')).toBe('external edit');
    await f.sandbox.applyBack([]);
  });
});
