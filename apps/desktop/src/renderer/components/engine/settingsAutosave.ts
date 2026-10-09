import type { EngineSettings } from '@nekko-agent/shared';

export function validateServerSettings(s: EngineSettings): string | null {
  if (!Number.isInteger(s.port) || s.port < 1024 || s.port > 65535) return 'Port must be an integer between 1024 and 65535.';
  if (!Number.isInteger(s.maxLoaded) || s.maxLoaded < 1 || s.maxLoaded > 8) return 'Models resident at once must be between 1 and 8.';
  if (!Number.isInteger(s.idleTtlSeconds) || s.idleTtlSeconds < 0 || s.idleTtlSeconds > 86400) return 'Idle timeout must be between 0 and 86400 seconds.';
  return null;
}

type Snapshot = { draft: EngineSettings; status: 'saved' | 'pending' | 'saving' | 'error'; error: string | null };
export class SettingsAutosave {
  private baseline: EngineSettings;
  private patch: Partial<EngineSettings> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private flushAgain = false;
  private listeners = new Set<() => void>();
  private snapshot: Snapshot;
  constructor(settings: EngineSettings, private save: (patch: Partial<EngineSettings>) => Promise<EngineSettings>, private changed: () => void) {
    this.baseline = settings;
    this.snapshot = { draft: settings, status: 'saved', error: null };
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  reconcile(settings: EngineSettings) {
    this.baseline = settings;
    this.publish(this.snapshot.status, this.snapshot.error);
  }
  private publish(status: Snapshot['status'], error: string | null = null) {
    this.snapshot = { draft: { ...this.baseline, ...this.patch }, status, error };
    this.listeners.forEach(listener => listener());
  }
  edit(draft: EngineSettings) {
    for (const key of Object.keys(draft) as (keyof EngineSettings)[]) {
      if (draft[key] !== this.snapshot.draft[key]) Object.assign(this.patch, { [key]: draft[key] });
    }
    this.publish('pending', validateServerSettings({ ...this.baseline, ...this.patch }));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, 2000);
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.inFlight) { this.flushAgain = true; return; }
    if (!Object.keys(this.patch).length) return;
    const invalid = validateServerSettings(this.snapshot.draft);
    if (invalid) { this.publish('error', invalid); return; }
    const sending = { ...this.patch };
    this.inFlight = true;
    this.publish('saving');
    try {
      this.baseline = await this.save(sending);
      for (const key of Object.keys(sending) as (keyof EngineSettings)[]) {
        if (this.patch[key] === sending[key]) delete this.patch[key];
      }
      this.publish(Object.keys(this.patch).length ? 'pending' : 'saved');
      this.changed();
    } catch (e) { this.publish('error', e instanceof Error ? e.message : 'Could not save server settings.'); }
    finally {
      this.inFlight = false;
      if (this.flushAgain) { this.flushAgain = false; if (this.snapshot.status !== 'error') await this.flush(); }
    }
  }
  dispose() { clearTimeout(this.timer); void this.flush(); this.listeners.clear(); }
}
