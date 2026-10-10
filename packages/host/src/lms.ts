import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { LmsProbe } from '@agent-nekko/shared';

/**
 * Per-model load/unload for LM Studio by shelling out to its `lms` CLI.
 *
 * LM Studio's OpenAI-compatible HTTP API exposes no per-model unload (only a
 * whole-server shutdown), so true per-model control needs the CLI. This governs
 * only the LM Studio instance running on *this* machine, so callers gate it on
 * the provider URL pointing at localhost, a remote LM Studio can't be driven
 * from here. Everything degrades gracefully: if `lms` isn't installed the Models
 * page falls back to the static "loaded" badge plus the Stop server action.
 *
 * Model keys line up across surfaces: the ids reported by `/api/v0/models`
 * (used by the Models list) are the same keys `lms load`/`lms unload` accept, so
 * a model's id can be passed straight through as the CLI identifier.
 */

const REMOTE_REASON =
  'Per-model load/unload needs the lms CLI on the machine running LM Studio. This server looks remote, use Stop server instead.';
const MISSING_REASON =
  "LM Studio's lms CLI wasn't found. Run `lms bootstrap` (or reinstall LM Studio) to enable per-model load/unload.";

// ESC[…m colour codes, built without a literal control char in the source.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// `lms load`/`lms unload` exit 0 even on some failures (e.g. an unknown model
// prints "Model Not Found" and still returns 0), so success is also gated on the
// output not matching a known failure phrase.
const FAILURE_RE =
  /(model not found|cannot find a model|no models are|is not loaded|not connected|failed to|error:)/i;

/** Resolve the `lms` binary: prefer LM Studio's default install path, else PATH. */
export function lmsBin(): string {
  const name = process.platform === 'win32' ? 'lms.exe' : 'lms';
  const bundled = join(homedir(), '.lmstudio', 'bin', name);
  return existsSync(bundled) ? bundled : 'lms';
}

/** Whether a base URL points at this machine, where `lms` can reach LM Studio. */
export function isLocalhostUrl(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch {
    return /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/i.test(baseUrl.trim());
  }
}

/** Run `lms <args>`, returning the exit success and its ANSI-stripped lines. */
function run(args: string[], timeoutMs: number): Promise<{ exit0: boolean; lines: string[] }> {
  return new Promise((resolve) => {
    execFile(lmsBin(), args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const stripped = `${stdout ?? ''}\n${stderr ?? ''}`.replace(ANSI_RE, '').replace(/\r/g, '');
      const lines = stripped.split('\n').map((l) => l.trim()).filter(Boolean);
      resolve({ exit0: !err, lines });
    });
  });
}

/**
 * Classify an `lms load`/`unload` result. `lms` sometimes exits 0 on failure, so
 * scan the whole output for a failure phrase. The headline (first line, e.g.
 * "Model Not Found") is the most useful bit for a toast.
 */
function result(lines: string[], exit0: boolean, ok: string, fail: string): { ok: boolean; message: string } {
  if (exit0 && !FAILURE_RE.test(lines.join(' '))) return { ok: true, message: ok };
  return { ok: false, message: lines.slice(0, 2).join('. ').slice(0, 240) || fail };
}

// `lms version` rarely changes mid-session; cache it so the Models page can poll
// a provider's capability without spawning a process every few seconds.
let versionOk: { at: number; ok: boolean } | null = null;
const VERSION_TTL_MS = 15_000;

async function lmsInstalled(): Promise<boolean> {
  const now = Date.now();
  if (versionOk && now - versionOk.at < VERSION_TTL_MS) return versionOk.ok;
  const { exit0 } = await run(['version'], 4_000);
  versionOk = { at: now, ok: exit0 };
  return exit0;
}

/**
 * Is per-model management available for an LM Studio provider at `baseUrl`?
 * Returns `available: false` with a UI-ready `reason` for remote servers or when
 * the `lms` CLI is missing.
 */
export async function lmsProbe(baseUrl: string): Promise<LmsProbe> {
  if (!isLocalhostUrl(baseUrl)) return { available: false, reason: REMOTE_REASON };
  return (await lmsInstalled()) ? { available: true } : { available: false, reason: MISSING_REASON };
}

/** Load a model into LM Studio (`lms load <key> -y`, LM Studio's default config). */
export async function lmsLoad(baseUrl: string, model: string): Promise<{ ok: boolean; message: string }> {
  if (!isLocalhostUrl(baseUrl)) return { ok: false, message: REMOTE_REASON };
  // Loading a large model into VRAM can take a while; give it room before the
  // timeout kills the child (a kill would abort the load).
  const { exit0, lines } = await run(['load', model, '-y'], 180_000);
  return result(lines, exit0, `Loaded ${model}`, `Couldn't load ${model}.`);
}

/** Unload a single model from LM Studio (`lms unload <key>`). */
export async function lmsUnload(baseUrl: string, model: string): Promise<{ ok: boolean; message: string }> {
  if (!isLocalhostUrl(baseUrl)) return { ok: false, message: REMOTE_REASON };
  const { exit0, lines } = await run(['unload', model], 15_000);
  return result(lines, exit0, `Unloaded ${model}`, `Couldn't unload ${model}.`);
}
