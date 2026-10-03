// Make sure the Electron binary is on disk before electron-vite starts it.
//
// Electron 43 no longer downloads its binary in a postinstall script: it fetches
// it the first time `require('electron')` runs. electron-vite reads
// `electron/path.txt` directly instead of requiring the package, so on a fresh
// install (a new clone, a chat worktree) it dies with "Electron uninstall".
// Requiring the package here triggers the download, and is a no-op once the
// binary is in place.
import { createRequire } from 'node:module';

createRequire(import.meta.url)('electron');
