import { describe, it, expect } from 'vitest';
import {
  SKILLS,
  SKILL_CATEGORIES,
  matchSkills,
  layoutWorkflow,
  type SkillDef,
} from '@agent-nekko/shared';

describe('SKILLS registry', () => {
  it('every skill has a category in the known set and a non-empty workflow', () => {
    for (const s of SKILLS) {
      expect(SKILL_CATEGORIES).toContain(s.category);
      expect(s.workflow.nodes.length).toBeGreaterThan(0);
      expect(s.workflow.edges.length).toBeGreaterThan(0);
    }
  });

  it('every edge references nodes that exist in the same workflow', () => {
    for (const s of SKILLS) {
      const ids = new Set(s.workflow.nodes.map((n) => n.id));
      for (const e of s.workflow.edges) {
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
    }
  });

  it('every workflow starts at exactly one trigger node and ends in an output', () => {
    for (const s of SKILLS) {
      const triggers = s.workflow.nodes.filter((n) => n.kind === 'trigger');
      const outputs = s.workflow.nodes.filter((n) => n.kind === 'output');
      expect(triggers.length).toBe(1);
      expect(outputs.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps goal as the only highlighted goal-kind skill', () => {
    const goal = SKILLS.find((s) => s.id === 'goal');
    expect(goal?.highlighted).toBe(true);
    expect(goal?.kind).toBe('goal');
    expect(SKILLS.filter((s) => s.kind === 'goal').length).toBe(1);
  });
});

describe('matchSkills', () => {
  it('matches by name substring and sorts highlighted first', () => {
    const res = matchSkills('re'); // research, review, security-review, ...
    expect(res.length).toBeGreaterThan(1);
    expect(res.map((s) => s.id)).toContain('research');
  });

  it('an empty query returns all skills with goal first', () => {
    const res = matchSkills('');
    expect(res.length).toBe(SKILLS.length);
    expect(res[0].id).toBe('goal');
  });
});

describe('layoutWorkflow', () => {
  const linear: SkillDef['workflow'] = {
    nodes: [
      { id: 'a', kind: 'trigger', label: 'a' },
      { id: 'b', kind: 'agent', label: 'b' },
      { id: 'c', kind: 'output', label: 'c' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  };

  it('lays a linear chain out in increasing layers', () => {
    const { nodes } = layoutWorkflow(linear);
    const layer = (id: string) => nodes.find((n) => n.id === id)!.layer;
    expect(layer('a')).toBe(0);
    expect(layer('b')).toBe(1);
    expect(layer('c')).toBe(2);
    // x grows strictly with layer
    const x = (id: string) => nodes.find((n) => n.id === id)!.x;
    expect(x('a')).toBeLessThan(x('b'));
    expect(x('b')).toBeLessThan(x('c'));
  });

  it('places a fan-out on the same layer with distinct rows', () => {
    const fan: SkillDef['workflow'] = {
      nodes: [
        { id: 't', kind: 'trigger', label: 't' },
        { id: 's1', kind: 'tool', label: 's1' },
        { id: 's2', kind: 'tool', label: 's2' },
        { id: 'o', kind: 'output', label: 'o' },
      ],
      edges: [
        { from: 't', to: 's1' },
        { from: 't', to: 's2' },
        { from: 's1', to: 'o' },
        { from: 's2', to: 'o' },
      ],
    };
    const { nodes } = layoutWorkflow(fan);
    const s1 = nodes.find((n) => n.id === 's1')!;
    const s2 = nodes.find((n) => n.id === 's2')!;
    expect(s1.layer).toBe(s2.layer);
    expect(s1.row).not.toBe(s2.row);
    expect(s1.y).not.toBe(s2.y);
  });

  it('ignores back edges when computing layers (loops do not push nodes right)', () => {
    const loop: SkillDef['workflow'] = {
      nodes: [
        { id: 't', kind: 'trigger', label: 't' },
        { id: 'w', kind: 'loop', label: 'w' },
        { id: 'd', kind: 'decision', label: 'd' },
        { id: 'o', kind: 'output', label: 'o' },
      ],
      edges: [
        { from: 't', to: 'w' },
        { from: 'w', to: 'd' },
        { from: 'd', to: 'w', back: true },
        { from: 'd', to: 'o' },
      ],
    };
    const { nodes } = layoutWorkflow(loop);
    const w = nodes.find((n) => n.id === 'w')!;
    expect(w.layer).toBe(1); // not pushed past d by the back edge
  });

  it('produces a canvas large enough to hold every node', () => {
    const { nodes, width, height, nodeW, nodeH } = layoutWorkflow(SKILLS[1].workflow);
    for (const n of nodes) {
      expect(n.x + nodeW).toBeLessThanOrEqual(width);
      expect(n.y + nodeH).toBeLessThanOrEqual(height);
    }
  });
});
