/**
 * The handshake file between the installed app and the installed CLI.
 *
 * `nekko-agent status` in a fresh terminal should just work. Environment
 * variables can't deliver that: the app would have to edit the user's shell
 * profile, which is somebody else's file, and the change wouldn't reach a
 * terminal that was already open anyway. So the app writes where it is
 * listening and what token to use into a small file in the data directory, and
 * the CLI reads it when nothing more specific was given.
 *
 * Precedence, strongest first: an explicit `--url`/`--token` flag, then
 * `NEKKO_URL`/`NEKKO_TOKEN` in the environment, then this file, then the local
 * data directory (no server at all). A person who sets the env var meant it;
 * this file is only the default nobody had to type.
 *
 * It holds a bearer token that grants shell access, so it is written
 * `0600` and lives beside the rest of the private data.
 */

/** File name inside the data dir. */
export const CLI_LINK_FILE = 'cli-link.json';

export interface CliLink {
  /** Where the app is serving, as a client should dial it. */
  url: string;
  /** The bearer token for that server. */
  token: string;
  /** When the app last wrote this, so a stale file can be recognised. */
  updatedAt: number;
  /**
   * False when the app has the server switched off. The file is kept rather
   * than deleted so the CLI can say "the app is not serving" instead of
   * silently falling back to a second copy of the data directory.
   */
  enabled: boolean;
  /**
   * The app process that wrote this. A link whose process is gone describes a
   * server that is not there (the app quit without saying so, or crashed), so
   * the CLI treats it as not serving instead of dialling a dead port.
   */
  pid?: number;
}

/** Whether a parsed object is a usable link. */
export function isCliLink(value: unknown): value is CliLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as Partial<CliLink>;
  return typeof link.url === 'string' && !!link.url && typeof link.token === 'string' && !!link.token;
}

/**
 * The state of the `nekko-agent` command on this machine, as the Server tab
 * reports it.
 *
 * The desktop app ships the CLI inside itself and links a small launcher into
 * a directory on the user's PATH, so "install the CLI" is something the app
 * did rather than something the user has to be told to do. Two things can
 * still be false, and they fail differently: the launcher might not be written
 * (a read-only home, an antivirus), or it might be written somewhere the shell
 * won't look (PATH not picked up until the terminal is reopened).
 */
export interface CliInstallStatus {
  /**
   * Whether this edition ships a CLI to link at all. False on web and
   * self-hosted, where the CLI is an npm install like any other.
   */
  available: boolean;
  /** The launcher is in place. */
  installed: boolean;
  /** Its directory is on PATH, so plain `nekko-agent` resolves. */
  onPath: boolean;
  /**
   * PATH was changed but this machine's already-open shells predate it. The
   * usual "reopen your terminal" caveat, said only when it's true.
   */
  needsRestart?: boolean;
  /** Absolute path of the launcher, for the UI to show and for a manual PATH. */
  binPath?: string;
  /** The directory that has to be on PATH. */
  binDir?: string;
  /** What to type: `nekko-agent` when on PATH, the full path when not. */
  command: string;
  /** Why it isn't installed, when it isn't. */
  message?: string;
}
