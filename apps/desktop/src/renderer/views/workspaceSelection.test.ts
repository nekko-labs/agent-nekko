import { describe, expect, it } from 'vitest';
import { selectWorkspaceRows } from './workspaceSelection.js';
describe('workspace row selection', () => {
  it('toggles rows without opening them', () => {
    expect(selectWorkspaceRows(['a'], ['a','b'], 'b', null, false)).toEqual(['a','b']);
    expect(selectWorkspaceRows(['a','b'], ['a','b'], 'a', null, false)).toEqual(['b']);
  });
  it('selects an inclusive forward or backward visible range', () => {
    expect(selectWorkspaceRows([], ['a','b','c'], 'c', 'a', true)).toEqual(['a','b','c']);
    expect(selectWorkspaceRows([], ['a','b','c'], 'a', 'c', true)).toEqual(['a','b','c']);
  });
  it('falls back to toggle if the anchor was hidden or removed', () => {
    expect(selectWorkspaceRows([], ['b','c'], 'c', 'a', true)).toEqual(['c']);
  });
});
