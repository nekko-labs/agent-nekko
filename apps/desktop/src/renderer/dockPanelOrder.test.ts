import { describe, expect, it } from 'vitest';
import { DEFAULT_WALL_STATE, DOCK_PANELS, loadWallState, normalizeDockPanelOrder, placeDockPanel, reorderDockPanel, sanitizeWallDock, saveWallState, toWallSetting } from './commandWall.js';

const defaults = DOCK_PANELS.map(p => p.key);

describe('dock panel order', () => {
  it('defaults legacy and malformed orders without losing any panels', () => {
    for (const raw of [undefined, null, false, {}, 'hardware', []]) {
      expect(normalizeDockPanelOrder(raw)).toEqual(defaults);
    }
    expect(normalizeDockPanelOrder(['hardware', 'alien', 'hardware', null, 'budget']))
      .toEqual(['hardware', 'budget', 'vitals', 'utilization', 'automations', 'insights']);
    expect(sanitizeWallDock({}).panelOrder).toEqual(defaults);
  });

  it('moves in either direction, keeps all panels, and does not mutate input', () => {
    const original = [...defaults];
    expect(reorderDockPanel(original, 'vitals', 'budget'))
      .toEqual(['hardware', 'utilization', 'budget', 'vitals', 'automations', 'insights']);
    expect(reorderDockPanel(original, 'hardware', 'automations'))
      .toEqual(['vitals', 'utilization', 'budget', 'automations', 'hardware', 'insights']);
    expect(reorderDockPanel(original, 'budget', 'budget')).toEqual(original);
    expect(original).toEqual(defaults);
    expect(new Set(reorderDockPanel(['hardware', 'hardware'], 'hardware', 'vitals')).size).toBe(6);
  });

  it('places a dropped panel before or after the landing zone anchor', () => {
    const original = [...defaults];
    expect(placeDockPanel(original, 'vitals', 'budget', 'before'))
      .toEqual(['hardware', 'utilization', 'vitals', 'budget', 'automations', 'insights']);
    expect(placeDockPanel(original, 'vitals', 'insights', 'after'))
      .toEqual(['hardware', 'utilization', 'budget', 'automations', 'insights', 'vitals']);
    expect(placeDockPanel(original, 'insights', 'hardware', 'before'))
      .toEqual(['vitals', 'insights', 'hardware', 'utilization', 'budget', 'automations']);
    expect(placeDockPanel(original, 'budget', 'budget', 'after')).toEqual(original);
    expect(original).toEqual(defaults);
  });

  it('round-trips order through both persistence paths, preserving visibility and minimization', () => {
    const dock = sanitizeWallDock({ side: 'left', panelOrder: ['hardware', 'insights'], panels: { hardware: false, insights: true }, minimized: { insights: true, utilization: true } });
    const state = { ...DEFAULT_WALL_STATE, dock: { ...dock, panelOrder: reorderDockPanel(dock.panelOrder, 'vitals', 'hardware') } };
    let saved = '';
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    saveWallState(storage, state);
    expect(loadWallState(storage).dock).toEqual(state.dock);
    expect(loadWallState(undefined, toWallSetting(state)).dock).toEqual(state.dock);
    expect(state.dock.panels).toEqual(dock.panels);
    expect(state.dock.minimized).toEqual(dock.minimized);
  });
});
