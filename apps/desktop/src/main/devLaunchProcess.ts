import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

/** A private per-launch receipt lets the wrapper stop only its own app. */
export function registerDevLaunch(app: { quit(): void; on(event: 'will-quit', handler: () => void): unknown }): void {
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
