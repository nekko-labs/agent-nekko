/**
 * The two IPC channels between the preload and the Electron main process
 * that are not part of `NekkoApi`. Shared by both sides (like
 * `windowChrome.ts`) so neither imports the other's Electron-only modules.
 */

/** Where the preload asks for the engine's address and token. */
export const ENGINE_ENDPOINT_CHANNEL = 'engine:endpoint';

/** The native folder picker, answered with a path (or null) for the preload to add. */
export const PICK_FOLDER_CHANNEL = 'dialog:pickFolder';
