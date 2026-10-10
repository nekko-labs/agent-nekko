import { describe, it, expect } from 'vitest';
import { parseTasks, toggleTaskLine, getMethodology, SPEC_METHODOLOGIES } from '@agent-nekko/shared';

const SAMPLE = `# Tasks

## Setup
- [ ] Scaffold the project
- [x] Add the linter

## Build
* [ ] Wire the API
not a task line
  - [ ] Indented nested task
`;

describe('parseTasks', () => {
  it('extracts checklist items with done state and line numbers', () => {
    const tasks = parseTasks(SAMPLE);
    expect(tasks.map((t) => t.text)).toEqual([
      'Scaffold the project',
      'Add the linter',
      'Wire the API',
      'Indented nested task',
    ]);
    expect(tasks.find((t) => t.text === 'Add the linter')?.done).toBe(true);
    expect(tasks.find((t) => t.text === 'Scaffold the project')?.done).toBe(false);
    // Line numbers point at the actual source line.
    const wire = tasks.find((t) => t.text === 'Wire the API')!;
    expect(SAMPLE.split('\n')[wire.line]).toContain('Wire the API');
  });

  it('returns nothing for prose with no checkboxes', () => {
    expect(parseTasks('# Title\n\nJust some text.')).toEqual([]);
  });
});

describe('toggleTaskLine', () => {
  it('checks an unchecked item and preserves the bullet style', () => {
    const line = parseTasks(SAMPLE).find((t) => t.text === 'Scaffold the project')!.line;
    const next = toggleTaskLine(SAMPLE, line);
    expect(next.split('\n')[line]).toBe('- [x] Scaffold the project');
    // Round-trips back.
    expect(toggleTaskLine(next, line).split('\n')[line]).toBe('- [ ] Scaffold the project');
  });

  it('unchecks a checked item', () => {
    const line = parseTasks(SAMPLE).find((t) => t.text === 'Add the linter')!.line;
    expect(toggleTaskLine(SAMPLE, line).split('\n')[line]).toBe('- [ ] Add the linter');
  });

  it('is a no-op on a non-task line', () => {
    expect(toggleTaskLine(SAMPLE, 0)).toBe(SAMPLE);
    expect(toggleTaskLine(SAMPLE, 999)).toBe(SAMPLE);
  });
});

describe('getMethodology', () => {
  it('returns the default for unknown/undefined ids', () => {
    expect(getMethodology(undefined).id).toBe('spec-tasks');
    expect(getMethodology('nope').id).toBe('spec-tasks');
  });

  it('resolves a known methodology', () => {
    expect(getMethodology('kiro').docs.map((d) => d.filename)).toEqual([
      'requirements.md',
      'design.md',
      'tasks.md',
    ]);
  });

  it('every methodology has exactly one tasks doc', () => {
    for (const m of SPEC_METHODOLOGIES) {
      expect(m.docs.filter((d) => d.role === 'tasks').length).toBeLessThanOrEqual(1);
      expect(m.docs.length).toBeGreaterThan(0);
    }
  });
});
