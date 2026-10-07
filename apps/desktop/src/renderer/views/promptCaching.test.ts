import { describe, expect, it, vi } from 'vitest';
vi.mock('../chrome.js', () => ({ hasAppChrome: false, isMacChrome: false }));
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}), setState: () => {} }) }));
import { promptCachingEnabled } from '@agent-nekko/shared';
import type { AppSettings } from '@agent-nekko/shared';
import { Toggle } from './SettingsView.js';

// The real Settings mount/remount path is also exercised in the isolated Electron fixture.
describe('prompt caching Settings switch', () => {
  it.each([undefined, true, false])('reflects the saved value %s, defaulting to on', (promptCaching) => {
    const control = Toggle({ on: promptCachingEnabled({ promptCaching }), onChange: () => {}, 'aria-label': 'Prompt caching' });
    expect(control.props.role).toBe('switch');
    expect(control.props['aria-label']).toBe('Prompt caching');
    expect(control.props['aria-checked']).toBe(promptCaching !== false);
  });

  it('writes explicit off and on patches and reflects them when reconstructed', () => {
    let saved: Pick<AppSettings, 'promptCaching'> = {};
    const patches: Partial<AppSettings>[] = [];
    const mount = () => Toggle({
      on: promptCachingEnabled(saved),
      onChange: (value) => {
        const patch = { promptCaching: value };
        patches.push(patch);
        saved = { ...saved, ...patch };
      },
    });
    mount().props.onClick();
    expect(saved.promptCaching).toBe(false);
    expect(mount().props['aria-checked']).toBe(false);
    mount().props.onClick();
    expect(saved.promptCaching).toBe(true);
    expect(mount().props['aria-checked']).toBe(true);
    expect(patches).toEqual([{ promptCaching: false }, { promptCaching: true }]);
  });
});
