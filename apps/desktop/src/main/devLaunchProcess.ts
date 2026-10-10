import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';

type DevApp = { quit(): void; on(event: 'will-quit', handler: () => void): unknown };

/** A private per-launch receipt lets the wrapper stop only its own app. */
export function registerDevLaunch(app: DevApp): void {
  watchStopFile(app);
  const file = process.env.NEKKO_DEV_PID_FILE;
  const token = process.env.NEKKO_DEV_LAUNCH_TOKEN;
  if (!file || !token) return;
  writeFileSync(file, JSON.stringify({ pid: process.pid, token, owner: process.env.NEKKO_DEV_OWNER }));
  const stop = () => app.quit();
  process.on('SIGTERM', stop);
  app.on('will-quit', () => {
    process.off('SIGTERM', stop);
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) unlinkSync(file); } catch { /* already removed */ }
  });
}

/**
 * `npm run dev` asks for a clean stop by creating this file (Enter, q or
 * Ctrl+C in its terminal). A signal can't do it on Windows, where killing a
 * process is always abrupt; a normal quit stops the engine and its model
 * servers on the way out instead of orphaning them.
 */
function watchStopFile(app: DevApp): void {
  const stopFile = process.env.NEKKO_DEV_STOP_FILE;
  if (!stopFile) return;
  const poll = setInterval(() => {
    if (!existsSync(stopFile)) return;
    clearInterval(poll);
    app.quit();
  }, 250);
  poll.unref?.();
  app.on('will-quit', () => clearInterval(poll));
}
