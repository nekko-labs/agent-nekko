import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir, stat, chmod, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import type { VoiceStatus, AppSettings } from '@nekko-agent/shared';

const MODEL = { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en-q5_1.bin', hash: 'c77c5766f1cef09b6b7d47f21b546cbddd4157886b3b5d6d4f709e91e66c7c2b' };
export const VOICE_BUILDS: Record<string, { name: string; hash: string }> = {
  'win32-x64': { name: 'whisper-bin-x64.zip', hash: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a' },
  'linux-x64': { name: 'whisper-bin-ubuntu-x64.tar.gz', hash: '46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1' },
  'linux-arm64': { name: 'whisper-bin-ubuntu-arm64.tar.gz', hash: '7e26fa6a36d9174d5c0bf033ccbc026c3b5e569e2ee787058241346ef5392719' },
};
const NOTICE = `Nekko Voice uses Whisper Tiny.en Q5_1 (OpenAI) and whisper.cpp (ggml authors).\n\nMIT License\nCopyright (c) 2022 OpenAI\nCopyright (c) 2023-2026 The ggml authors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`;

export function validateVoiceWav(bytes: number[]): Buffer {
  if (!Array.isArray(bytes) || bytes.length < 46 || bytes.length > 44 + 16000 * 2 * 60 || bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error('Voice audio must be a PCM WAV recording of at most 60 seconds.');
  const b = Buffer.from(bytes);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE' || b.toString('ascii', 12, 16) !== 'fmt ' || b.readUInt32LE(16) !== 16 || b.readUInt16LE(20) !== 1 || b.readUInt16LE(22) !== 1 || b.readUInt32LE(24) !== 16000 || b.readUInt16LE(34) !== 16 || b.toString('ascii', 36, 40) !== 'data' || b.readUInt32LE(40) !== b.length - 44) throw new Error('Expected mono 16kHz 16-bit PCM WAV.');
  return b;
}
export async function validateVoiceModel(path: string) {
  const file = await open(path, 'r');
  try { const b = Buffer.alloc(4); await file.read(b, 0, 4, 0); if (b.readUInt32LE() !== 0x67676d6c) throw new Error('Choose a whisper.cpp GGML speech model (.bin), not an LLM GGUF.'); }
  finally { await file.close(); }
}

export function createVoiceService(dir: string, settings: () => AppSettings) {
  let controller: AbortController | undefined;
  let progress = 0;
  let error: string | undefined;
  let child: ChildProcess | undefined;
  let endpoint = '';
  let modelKey = '';
  let busy = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const build = VOICE_BUILDS[`${process.platform}-${process.arch}`];
  const stop = () => { clearTimeout(idle); child?.kill(); child = undefined; endpoint = ''; };
  const paths = async () => {
    const record = JSON.parse(await readFile(join(dir, 'install.json'), 'utf8').catch(() => '{}')) as { runtimePath?: string };
    return { runtimePath: settings().voice?.runtimePath || record.runtimePath, modelPath: settings().voice?.modelPath || join(dir, 'tiny.en-q5_1.bin') };
  };
  const status = async (): Promise<VoiceStatus> => {
    const p = await paths();
    const installed = !!p.runtimePath && !!(await stat(p.runtimePath).catch(() => null))?.isFile() && !!(await stat(p.modelPath).catch(() => null))?.isFile();
    return { ...p, installed, installing: !!controller, progress, error, running: !!child, supported: !!build || !!settings().voice?.runtimePath };
  };
  async function download(url: string, dest: string, hash: string, signal: AbortSignal, offset: number) {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const chunks: Uint8Array[] = []; let size = 0;
    const total = Number(response.headers.get('content-length'));
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length; if (size > 150 * 1024 * 1024) throw new Error('Voice download exceeds size limit.');
      chunks.push(chunk); progress = offset + (total ? Math.min(size / total, 1) : 0) * 0.45;
    }
    const data = Buffer.concat(chunks);
    if (createHash('sha256').update(data).digest('hex') !== hash) throw new Error('Voice download checksum mismatch.');
    signal.throwIfAborted(); await writeFile(dest + '.partial', data); await rename(dest + '.partial', dest);
  }
  const find = async (root: string): Promise<string | undefined> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) { const found = await find(path); if (found) return found; }
      else if (/^whisper-server(?:\.exe)?$/.test(entry.name)) return path;
    }
  };
  const install = async () => {
    if (controller) return status();
    if (!build) throw new Error('No verified downloadable speech server for this platform. Set a custom whisper-server path in Voice settings.');
    controller = new AbortController(); error = undefined; progress = 0;
    const signal = controller.signal;
    void (async () => {
      try {
        await mkdir(dir, { recursive: true });
        const archive = join(dir, build.name);
        await download(`https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/${build.name}`, archive, build.hash, signal, 0);
        const runtime = join(dir, 'runtime'); await mkdir(runtime, { recursive: true });
        await new Promise<void>((resolve, reject) => execFile('tar', ['-xf', archive, '-C', runtime], { timeout: 60000, windowsHide: true, signal }, e => e ? reject(e) : resolve()));
        const runtimePath = await find(runtime); if (!runtimePath) throw new Error('Archive has no whisper-server binary.');
        if (process.platform !== 'win32') await chmod(runtimePath, 0o755);
        await download(MODEL.url, join(dir, 'tiny.en-q5_1.bin'), MODEL.hash, signal, 0.45);
        await validateVoiceModel(join(dir, 'tiny.en-q5_1.bin'));
        await writeFile(join(dir, 'THIRD-PARTY-NOTICES.txt'), NOTICE);
        signal.throwIfAborted(); await writeFile(join(dir, 'install.json'), JSON.stringify({ runtimePath, version: 'v1.9.2' }));
        await rm(archive, { force: true }); progress = 1;
      } catch (e) { error = signal.aborted ? 'Download cancelled. Click Download to retry.' : (e as Error).message; }
      finally { controller = undefined; }
    })();
    return status();
  };
  async function transcribe(bytes: number[]) {
    if (!settings().voice?.enabled) throw new Error('Voice is disabled in Settings.');
    const audio = validateVoiceWav(bytes);
    if (busy) throw new Error('Voice transcription is already running.');
    busy = true; clearTimeout(idle);
    try {
      const p = await paths(); if (!p.runtimePath) throw new Error('Download Nekko Voice first.');
      await validateVoiceModel(p.modelPath);
      const voice = settings().voice;
      const key = `${p.runtimePath}:${p.modelPath}:${voice?.threads}`;
      if (child && modelKey !== key) stop();
      if (!child) {
        const port = await new Promise<number>((resolve, reject) => { const s = createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); }); });
        endpoint = `http://127.0.0.1:${port}`; modelKey = key;
        child = spawn(p.runtimePath, ['-m', p.modelPath, '--host', '127.0.0.1', '--port', String(port), '-ng', '-t', String(Math.max(1, Math.min(8, voice?.threads ?? 2)))], { windowsHide: true, stdio: 'ignore' });
        let failure = ''; const started = child; child.on('error', e => { failure = e.message; if (child === started) stop(); }); child.on('exit', () => { if (child === started) child = undefined; });
        let ready = false;
        for (let i = 0; i < 150; i++) {
          if (failure || !child) throw new Error(failure || 'Speech server exited. Check the runtime and model.');
          try { const r = await fetch(endpoint + '/health', { signal: AbortSignal.timeout(500) }); if (r.ok) { ready = true; break; } } catch { /* wait for model loading */ }
          await new Promise(r => setTimeout(r, 200));
        }
        if (!ready) { stop(); throw new Error('Speech server startup timed out.'); }
      }
      const form = new FormData(); form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'voice.wav');
      form.append('response_format', 'json'); form.append('language', voice?.language || 'en'); form.append('temperature', '0');
      const response = await fetch(endpoint + '/inference', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`Local transcription failed (${response.status}).`);
      const result = await response.json() as { text?: string };
      return result.text?.trim() || '';
    } finally { busy = false; idle = setTimeout(stop, Math.max(10, Math.min(600, settings().voice?.idleSeconds ?? 60)) * 1000); idle.unref(); }
  }
  process.once('exit', stop);
  return { status, install, transcribe, stop, cancel: async () => { controller?.abort(); }, uninstall: async () => { if (controller || busy) throw new Error('Stop voice work before uninstalling.'); stop(); await rm(dir, { recursive: true, force: true }); } };
}
