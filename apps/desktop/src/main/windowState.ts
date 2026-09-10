import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { dataDir } from '@agent-nekko/host';

export interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const FILE = () => join(dataDir(), 'window-state.json');
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
