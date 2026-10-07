import { describe, expect, it, vi } from 'vitest';
vi.mock('../store.js', () => ({ useStore: Object.assign(() => ({}), { getState: () => ({}) }) }));
vi.mock('../components/AgentWindowPicker.js', () => ({ AgentWindowPicker: () => null }));
vi.mock('../components/InsightsBox.js', () => ({}));
vi.mock('../components/CommandWall.js', () => ({ CommandWall: () => null, TerminalExcerpt: () => null }));
vi.mock('../components/WallComposer.js', () => ({ WallComposer: () => null }));
vi.mock('../components/WallDock.js', () => ({ WallDock: () => null }));
vi.mock('../chrome.js', () => ({ hasAppChrome: false }));
import { wallLayoutShortcut } from './CommandCenterView.js';

const key = { code: 'Digit1', key: '!', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false, defaultPrevented: false };
describe('command center layout shortcuts', () => {
  it.each([['Digit1', '!', 'focus'], ['Digit2', '@', 'grid'], ['Digit3', '#', 'fixed']])('maps shifted %s to %s', (code, value, mode) => {
    expect(wallLayoutShortcut({ ...key, code, key: value })).toBe(mode);
    expect(wallLayoutShortcut({ ...key, code, key: value, ctrlKey: false, metaKey: true })).toBe(mode);
  });
  it.each([{ shiftKey: false }, { altKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: false }, { code: 'Digit4', key: '$' }])('ignores unsupported modifiers and events %j', (patch) => {
    expect(wallLayoutShortcut({ ...key, ...patch })).toBeNull();
  });
  it('supports synthetic digit keys but never steals unshifted agent selection', () => {
    expect(wallLayoutShortcut({ ...key, code: '', key: '2' })).toBe('grid');
    expect(wallLayoutShortcut({ ...key, key: '1', shiftKey: false })).toBeNull();
  });
});
