import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_SETTINGS } from '@agent-nekko/shared';
import { SettingsAutosave } from './settingsAutosave.js';

afterEach(() => vi.useRealTimers());
describe('server settings autosave', () => {
  it('debounces edits for two seconds and saves only changed fields', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async patch => ({ ...DEFAULT_ENGINE_SETTINGS, ...patch }));
    const a = new SettingsAutosave(DEFAULT_ENGINE_SETTINGS, save, () => {});
    a.edit({ ...a.getSnapshot().draft, port: 1555 });
    await vi.advanceTimersByTimeAsync(1900);
    expect(save).not.toHaveBeenCalled();
    a.edit({ ...a.getSnapshot().draft, port: 1666 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledExactlyOnceWith({ port: 1666 });
  });
  it('flushes immediately on blur and keeps drafts across polling', async () => {
    const save = vi.fn(async patch => ({ ...DEFAULT_ENGINE_SETTINGS, ...patch }));
    const a = new SettingsAutosave(DEFAULT_ENGINE_SETTINGS, save, () => {});
    a.edit({ ...a.getSnapshot().draft, port: 1555 });
    a.reconcile({ ...DEFAULT_ENGINE_SETTINGS, autoStart: true });
    expect(a.getSnapshot().draft.port).toBe(1555);
    expect(a.getSnapshot().draft.autoStart).toBe(true);
    await a.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith({ port: 1555 });
  });
  it('serializes writes and keeps newer edits while a save is in flight', async () => {
    let done!: (v: typeof DEFAULT_ENGINE_SETTINGS) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise(r => { done = r; })).mockImplementation(async patch => ({ ...DEFAULT_ENGINE_SETTINGS, ...patch }));
    const a = new SettingsAutosave(DEFAULT_ENGINE_SETTINGS, save, () => {});
    a.edit({ ...a.getSnapshot().draft, port: 1555 });
    const saving = a.flush();
    a.edit({ ...a.getSnapshot().draft, port: 1666 });
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);
    done({ ...DEFAULT_ENGINE_SETTINGS, port: 1555 });
    await saving;
    expect(save).toHaveBeenLastCalledWith({ port: 1666 });
    expect(a.getSnapshot().draft.port).toBe(1666);
    a.dispose();
  });
  it('does not save invalid numbers and preserves failed drafts for retry', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Connection lost'));
    const a = new SettingsAutosave(DEFAULT_ENGINE_SETTINGS, save, () => {});
    a.edit({ ...a.getSnapshot().draft, port: 0 });
    await a.flush();
    expect(save).not.toHaveBeenCalled();
    a.edit({ ...a.getSnapshot().draft, port: 1555 });
    await a.flush();
    expect(a.getSnapshot().draft.port).toBe(1555);
    expect(a.getSnapshot().status).toBe('error');
    a.dispose();
  });
});
