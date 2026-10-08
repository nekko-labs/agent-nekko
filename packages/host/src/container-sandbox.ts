import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeJsonAtomic } from './secure-file.js';

export interface SandboxLimits { files: number; bytes: number; outputBytes: number; timeoutMs: number }
export interface SandboxConfig {
  sessionId: string;
  stateDirectory: string;
  sourceFolders: string[];
  /** A locally installed Linux image with python3 and /bin/sh, pinned by sha256 digest. */
  image: string;
  dockerPath?: string;
  limits?: Partial<SandboxLimits>;
}
export interface RunResult { stdout: string; stderr: string }
export type SandboxRunner = (executable: string, args: string[], options: { windowsHide: true; timeout: number; maxBuffer: number }) => Promise<RunResult>;
export interface SnapshotFile { path: string; base64: string; hash: string }
export interface SandboxChange { path: string; before: string | null; after: SnapshotFile | null }
interface Manifest {
  version: 1; sessionId: string; token: string; container: string; volume: string;
  image: string; roots: string[]; baseline: Record<string, string>; phase: 'creating' | 'ready' | 'destroyed';
}
const defaults: SandboxLimits = { files: 5000, bytes: 32 * 1024 * 1024, outputBytes: 48 * 1024 * 1024, timeoutMs: 30000 };
export const defaultSandboxRunner: SandboxRunner = (executable, args, options) => new Promise((resolve, reject) => {
  execFile(executable, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
});
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const omitted = (name: string) => name === '.git' || name === 'node_modules' || name === '.env' || name.startsWith('.env.');
function relativeFile(value: string): string {
  if (!value || value.includes('\\') || value.includes(':') || /[\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some((p) => !p || p === '.' || p === '..' || omitted(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Unsafe workspace path');
  return value;
}
function assertPlain(target: string): void {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw new Error('Links and special files are not permitted');
    const real = fs.realpathSync.native(current);
    const normalize = (v: string) => process.platform === 'win32' ? v.toLowerCase() : v;
    if (normalize(real) !== normalize(current)) throw new Error('Reparse/alias path is not permitted');
  }
}
function plainRead(target: string): Buffer {
  assertPlain(target);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Not a plain file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// All filesystem traversal happens inside the container. No archive is extracted on the host.
const helper = String.raw`
import os,sys,json,base64,hashlib,stat,fnmatch,re
q=json.loads(sys.argv[1]); root='/workspace'; limit=q['limits']; op=q['op']
def safe(p):
 if not isinstance(p,str) or not p or p.startswith('/') or '\\' in p or ':' in p or any(x in ('','.', '..','.git','node_modules') or x=='.env' or x.startswith('.env.') for x in p.split('/')): raise Exception('unsafe path')
 full=root+'/'+p; current=root
 for part in p.split('/'):
  current+='/'+part
  if os.path.lexists(current):
   s=os.lstat(current)
   if stat.S_ISLNK(s.st_mode) or not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode)) or (stat.S_ISREG(s.st_mode) and s.st_nlink!=1): raise Exception('link/special file')
 return full
def read(p):
 f=os.open(safe(p),os.O_RDONLY|os.O_NOFOLLOW)
 try:
  s=os.fstat(f)
  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>limit['bytes']: raise Exception('invalid file')
  with os.fdopen(f,'rb',closefd=False) as h: return h.read(limit['bytes']+1)
 finally: os.close(f)
def snapshot():
 out=[]; size=0
 for directory,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files: safe(os.path.relpath(directory+'/'+name,root))
  for name in files:
   p=os.path.relpath(directory+'/'+name,root); b=read(p); size+=len(b)
   if size>limit['bytes'] or len(out)>=limit['files']: raise Exception('workspace limit exceeded')
   out.append({'path':p,'base64':base64.b64encode(b).decode(),'hash':hashlib.sha256(b).hexdigest()})
 return out
if op=='snapshot': result=snapshot()
elif op in ('write','append'):
 p=q['path']; b=base64.b64decode(q['base64'],validate=True)
 if len(b)>limit['bytes']: raise Exception('file too large')
 full=safe(p); os.makedirs(os.path.dirname(full),exist_ok=True); safe(p)
 f=os.open(full,os.O_WRONLY|os.O_CREAT|(os.O_APPEND if op=='append' else os.O_TRUNC)|os.O_NOFOLLOW,0o600)
 try: os.write(f,b)
 finally: os.close(f)
 result={'written':p}
elif op=='read': result={'base64':base64.b64encode(read(q['path'])).decode()}
elif op=='edit':
 p=q['path']; text=read(p).decode(); old=q['old_string']
 if not old or text.count(old)!=1: raise Exception('edit requires one exact match')
 b=text.replace(old,q['new_string']).encode()
 if len(b)>limit['bytes']: raise Exception('file too large')
 f=os.open(safe(p),os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW)
 try: os.write(f,b)
 finally: os.close(f)
 result={'edited':p}
elif op in ('list','glob','grep'):
 entries=snapshot(); prefix=q.get('path',''); result=[]
 for e in entries:
  p=e['path']
  if prefix and not (p==prefix or p.startswith(prefix+'/')): continue
  if op=='list': result.append(p)
  elif op=='glob' and fnmatch.fnmatchcase(p,q['pattern']): result.append(p)
  elif op=='grep':
   for i,line in enumerate(base64.b64decode(e['base64']).decode('utf8',errors='replace').splitlines(),1):
    if re.search(q['pattern'],line): result.append({'path':p,'line':i,'text':line})
else: raise Exception('unsupported operation')
print(json.dumps(result,separators=(',',':')))
`;

export class ContainerSandbox {
  private readonly limits: SandboxLimits;
  private readonly manifestPath: string;
  private docker = '';
  private manifest?: Manifest;
  private busy = false;
  constructor(private readonly config: SandboxConfig, private readonly runner: SandboxRunner = defaultSandboxRunner) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(config.sessionId)) throw new Error('Invalid session id');
    if (!/^\S+@sha256:[a-f0-9]{64}$/.test(config.image)) throw new Error('Explicit digest-pinned image required');
    this.limits = { ...defaults, ...config.limits };
    for (const value of Object.values(this.limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid limits');
    this.manifestPath = path.join(path.resolve(config.stateDirectory), `${config.sessionId}.sandbox.json`);
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Sandbox operation already in progress');
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  private run(args: string[]) {
    return this.runner(this.docker, args, { windowsHide: true, timeout: this.limits.timeoutMs, maxBuffer: this.limits.outputBytes });
  }
  private save() { writeJsonAtomic(this.manifestPath, this.manifest); }
  private async discover() {
    const candidates = this.config.dockerPath ? [this.config.dockerPath] : process.platform === 'win32' ? ['C:/Program Files/Docker/Docker/resources/bin/docker.exe', 'docker.exe'] : ['docker'];
    let found = false;
    for (const candidate of candidates) {
      try { await this.runner(candidate, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 65536 }); this.docker = candidate; found = true; break; } catch { /* Try the next installed CLI, never start a service. */ }
    }
    if (!found) throw new Error('Docker CLI unavailable');
    const info = JSON.parse((await this.run(['info', '--format', '{{json .}}'])).stdout);
    if (info.OSType !== 'linux' || !info.ServerVersion) throw new Error('Ready Linux Docker engine required');
    const image = JSON.parse((await this.run(['image', 'inspect', this.config.image])).stdout)[0];
    if (image?.Os !== 'linux' || Object.keys(image.Config?.Volumes ?? {}).length || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('Pinned Linux image must already be installed');
    return image.Id as string;
  }
  private async verify() {
    const m = this.manifest;
    if (!m || m.phase !== 'ready') throw new Error('Sandbox is not ready');
    const c = JSON.parse((await this.run(['inspect', m.container])).stdout)[0];
    const h = c?.HostConfig;
    const volume = JSON.parse((await this.run(['volume', 'inspect', m.volume])).stdout)[0];
    if (volume?.Labels?.['dev.nekko.sandbox'] !== m.token || h?.Tmpfs?.['/tmp'] !== 'rw,noexec,nosuid,nodev,size=64m' || h?.MemorySwap !== 512 * 1024 * 1024 || h?.PidMode || h?.IpcMode === 'host' || h?.Devices?.length || h?.DeviceRequests?.length || Object.keys(h?.PortBindings ?? {}).length) throw new Error('Container resource or volume isolation mismatch');
    if (c?.Config?.Labels?.['dev.nekko.sandbox'] !== m.token || c?.Image !== m.image || !c?.State?.Running || c?.Config?.User !== '1000:1000' || h?.NetworkMode !== 'none' || !h?.ReadonlyRootfs || !h?.CapDrop?.includes('ALL') || !h?.SecurityOpt?.includes('no-new-privileges') || h?.Privileged || h?.Binds?.length || h?.Memory !== 512 * 1024 * 1024 || h?.PidsLimit !== 128 || h?.NanoCpus !== 1000000000 || c?.Mounts?.filter((x: { Type: string }) => x.Type !== 'tmpfs').some((x: { Type: string; Name: string; Destination: string; RW: boolean }) => x.Type !== 'volume' || x.Name !== m.volume || x.Destination !== '/workspace' || !x.RW) || c?.Mounts?.filter((x: { Destination: string }) => x.Destination === '/workspace').length !== 1) throw new Error('Container identity or isolation mismatch');
  }
  private async python(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return JSON.parse((await this.run(['exec', '--user', '1000:1000', this.manifest!.container, 'python3', '-I', '-c', helper, JSON.stringify({ ...args, op, limits: this.limits })])).stdout);
  }
  private async writeChunks(p: string, data: Buffer): Promise<unknown> {
    if (data.length > this.limits.bytes) throw new Error('File size limit exceeded');
    // Keep Windows execFile command lines well below its 32K UTF-16 ceiling.
    let result: unknown = await this.python('write', { path: p, base64: data.subarray(0, 4096).toString('base64') });
    for (let offset = 4096; offset < data.length; offset += 4096) result = await this.python('append', { path: p, base64: data.subarray(offset, offset + 4096).toString('base64') });
    return result;
  }
  async initialize(): Promise<void> {
    return this.exclusive(async () => {
      const image = await this.discover();
      fs.mkdirSync(this.config.stateDirectory, { recursive: true, mode: 0o700 });
      assertPlain(this.config.stateDirectory);
      const roots = this.config.sourceFolders.map((p) => path.resolve(p));
      if (!roots.length || new Set(roots.map((p) => p.toLowerCase())).size !== roots.length) throw new Error('Select unique source folders');
      for (const root of roots) { assertPlain(root); if (!fs.statSync(root).isDirectory()) throw new Error('Source must be a folder'); }
      if (fs.existsSync(this.manifestPath)) {
        const m = JSON.parse(plainRead(this.manifestPath).toString()) as Manifest;
        if (m.version !== 1 || m.sessionId !== this.config.sessionId || m.image !== image || JSON.stringify(m.roots) !== JSON.stringify(roots) || !/^[a-f0-9-]{36}$/.test(m.token) || m.container !== `nekko-${m.token}` || m.volume !== `nekko-${m.token}-workspace`) throw new Error('Manifest identity mismatch');
        this.manifest = m; await this.verify(); return;
      }
      const files: SnapshotFile[] = []; let bytes = 0;
      const walk = (root: string, rel: string, index: number) => {
        for (const name of fs.readdirSync(path.join(root, rel))) {
          if (omitted(name)) continue;
          const local = path.join(root, rel, name); assertPlain(local);
          const s = fs.lstatSync(local);
          if (s.isDirectory()) walk(root, path.join(rel, name), index);
          else {
            if (s.size > this.limits.bytes - bytes || files.length >= this.limits.files) throw new Error('Source copy limit exceeded');
            const b = plainRead(local); bytes += b.length;
            if (bytes > this.limits.bytes) throw new Error('Source copy limit exceeded');
            files.push({ path: relativeFile(`folder-${index}/${path.join(rel, name).split(path.sep).join('/')}`), base64: b.toString('base64'), hash: hash(b) });
          }
        }
      };
      roots.forEach((root, i) => walk(root, '', i));
      const token = randomUUID();
      this.manifest = { version: 1, sessionId: this.config.sessionId, token, container: `nekko-${token}`, volume: `nekko-${token}-workspace`, image, roots, baseline: Object.fromEntries(files.map((f) => [f.path, f.hash])), phase: 'creating' };
      this.save(); const m = this.manifest;
      await this.run(['volume', 'create', '--label', `dev.nekko.sandbox=${token}`, m.volume]);
      await this.run(['create', '--pull=never', '--name', m.container, '--label', `dev.nekko.sandbox=${token}`, '--network', 'none', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--mount', `type=volume,src=${m.volume},dst=/workspace,volume-nocopy`, '--workdir', '/workspace', '--entrypoint', 'python3', image, '-I', '-c', 'import time; time.sleep(2147483647)']);
      await this.run(['start', m.container]);
      // Only the private empty volume is initialized as root, never agent commands.
      await this.run(['exec', '--user', '0:0', m.container, 'python3', '-I', '-c', 'import os; os.chmod("/workspace",0o1777)']);
      for (const file of files) await this.writeChunks(file.path, Buffer.from(file.base64, 'base64'));
      this.manifest.phase = 'ready'; this.save(); await this.verify();
    });
  }
  async execute(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const ops: Record<string, string> = { read_file: 'read', write_file: 'write', edit_file: 'edit', list_dir: 'list', grep: 'grep', glob: 'glob' };
    if (!(tool in ops) && tool !== 'bash') throw new Error(`Unsupported sandbox tool: ${tool}`);
    return this.exclusive(async () => {
      await this.verify();
      if (tool === 'bash') {
        if (typeof args.command !== 'string' || !args.command) throw new Error('Command required');
        const cwd = args.cwd === undefined ? '/workspace' : `/workspace/${relativeFile(String(args.cwd))}`;
        return this.run(['exec', '--user', '1000:1000', '--workdir', cwd, this.manifest!.container, '/bin/sh', '-c', args.command]);
      }
      const input = { ...args };
      if (args.path !== undefined) input.path = relativeFile(String(args.path));
      if (tool === 'write_file') {
        if (typeof args.content !== 'string') throw new Error('Text content required');
        return this.writeChunks(relativeFile(String(args.path)), Buffer.from(args.content));
      }
      const result = await this.python(ops[tool], input);
      if (tool === 'read_file') return Buffer.from((result as { base64: string }).base64, 'base64').toString('utf8');
      return result;
    });
  }
  private validateSnapshot(raw: unknown): SnapshotFile[] {
    if (!Array.isArray(raw) || raw.length > this.limits.files) throw new Error('Invalid snapshot');
    let bytes = 0; const seen = new Set<string>();
    return raw.map((f) => {
      const p = relativeFile(f.path);
      if (seen.has(p.toLowerCase()) || typeof f.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.base64)) throw new Error('Invalid snapshot entry');
      seen.add(p.toLowerCase()); const b = Buffer.from(f.base64, 'base64'); bytes += b.length;
      if (bytes > this.limits.bytes || hash(b) !== f.hash) throw new Error('Snapshot hash/size mismatch');
      return { path: p, base64: f.base64, hash: f.hash };
    });
  }
  async snapshot(): Promise<SnapshotFile[]> {
    return this.exclusive(async () => { await this.verify(); return this.validateSnapshot(await this.python('snapshot')); });
  }
  async diff(): Promise<SandboxChange[]> {
    const files = await this.snapshot(); const current = new Map(files.map((f) => [f.path, f]));
    const baseline = this.manifest!.baseline;
    return [...new Set([...Object.keys(baseline), ...current.keys()])].sort().flatMap((p) => {
      const before = baseline[p] ?? null; const after = current.get(p) ?? null;
      return before === (after?.hash ?? null) ? [] : [{ path: p, before, after }];
    });
  }
  /** Explicit selections only. All conflicts are checked before any host write. */
  async applyBack(selected: SandboxChange[]): Promise<void> {
    if (!selected.length) return;
    return this.exclusive(async () => {
      await this.verify();
      const current = new Map(this.validateSnapshot(await this.python('snapshot')).map((f) => [f.path, f]));
      const seen = new Set<string>();
      const prepared = selected.map((change) => {
        const p = relativeFile(change.path); const m = /^folder-(\d+)\/(.+)$/.exec(p);
        if (!m || seen.has(p.toLowerCase()) || !this.manifest!.roots[Number(m[1])]) throw new Error('Invalid apply selection');
        seen.add(p.toLowerCase());
        const before = this.manifest!.baseline[p] ?? null;
        const after = current.get(p) ?? null;
        if (before !== change.before || (after?.hash ?? null) !== (change.after?.hash ?? null) || (after?.base64 ?? null) !== (change.after?.base64 ?? null)) throw new Error('Stale apply selection');
        const target = path.join(this.manifest!.roots[Number(m[1])], ...m[2].split('/'));
        assertPlain(path.dirname(target)); // Missing parents fail conservatively, never create host trees implicitly.
        if (before === null) { if (fs.existsSync(target)) throw new Error('Host addition conflict'); }
        else if (!fs.existsSync(target) || hash(plainRead(target)) !== before) throw new Error('Host baseline conflict');
        return { p, target, before, after };
      });
      // Synchronous preconditions and writes avoid JS-level interleaving. Concurrent external
      // filesystem mutation still requires caller-enforced exclusive host ownership.
      for (const item of prepared) {
        assertPlain(path.dirname(item.target));
        if (item.before !== null && hash(plainRead(item.target)) !== item.before) throw new Error('Host baseline changed during apply');
        if (item.after) {
          const fd = fs.openSync(item.target, item.before === null ? 'wx' : fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe apply target');
            if (item.before !== null && hash(fs.readFileSync(fd)) !== item.before) throw new Error('Host baseline changed during open');
            fs.ftruncateSync(fd, 0); fs.writeSync(fd, Buffer.from(item.after.base64, 'base64'), 0, Buffer.from(item.after.base64, 'base64').length, 0); fs.fsyncSync(fd);
          } finally { fs.closeSync(fd); }
          this.manifest!.baseline[item.p] = item.after.hash;
        } else { fs.unlinkSync(item.target); delete this.manifest!.baseline[item.p]; }
      }
      this.save();
    });
  }
  async destroy(): Promise<void> {
    return this.exclusive(async () => {
      await this.verify();
      const m = this.manifest!;
      const v = JSON.parse((await this.run(['volume', 'inspect', m.volume])).stdout)[0];
      if (v?.Labels?.['dev.nekko.sandbox'] !== m.token) throw new Error('Volume identity mismatch');
      await this.run(['rm', '-f', m.container]); await this.run(['volume', 'rm', m.volume]);
      m.phase = 'destroyed'; this.save();
    });
  }
}
