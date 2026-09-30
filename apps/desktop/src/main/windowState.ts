import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

/**
 * Set by main once it has decided the data directory. Main does not run the
 * host, so the host's own `dataDir()` is not initialised here (reading it
 * threw, the catch below swallowed it, and bounds silently stopped saving).
 */
let dir: string | null = null;
export function setWindowStateDir(path: string): void {
  dir = path;
}

const FILE = () => {
  if (!dir) throw new Error('window state directory not set');
  return join(dir, 'window-state.json');
};
const DEFAULTS: WindowBounds = { width: 1280, height: 840 };

export function loadWindowBounds(): WindowBounds {
  try {
    if (existsSync(FILE())) return { ...DEFAULTS, ...JSON.parse(readFileSync(FILE(), 'utf8')) };
  } catch {
    /* ignore */
  }
  return DEFAULTS;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  try {
    writeFileSync(FILE(), JSON.stringify(bounds), 'utf8');
  } catch {
    /* non-fatal */
  }
}
