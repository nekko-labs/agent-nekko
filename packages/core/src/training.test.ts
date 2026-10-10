import { describe, expect, it } from 'vitest';
import {
  APPROACH_PRESETS,
  bestExperiment,
  formatRuntime,
  getApproach,
  isBetterScore,
  layoutMaze,
  planProgress,
  runStats,
  type ExperimentNode,
  type PlanStep,
  type TrainingRun,
} from '@agent-nekko/shared';

function exp(partial: Partial<ExperimentNode> & { id: string }): ExperimentNode {
  return { title: partial.id, status: 'succeeded', createdAt: 0, updatedAt: 0, ...partial };
}

function run(partial: Partial<TrainingRun>): TrainingRun {
  return {
    id: 'r1',
    kind: 'training',
    name: 'test',
    goal: 'test goal',
    status: 'running',
    config: {},
    experiments: [],
    hints: [],
    log: [],
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('training helpers', () => {
  it('isBetterScore respects direction', () => {
    expect(isBetterScore(0.9, 0.8)).toBe(true);
    expect(isBetterScore(0.7, 0.8)).toBe(false);
    expect(isBetterScore(0.1, 0.2, true)).toBe(true);
    expect(isBetterScore(0.3, 0.2, true)).toBe(false);
    expect(isBetterScore(0.5, undefined)).toBe(true);
  });

  it('bestExperiment picks the leader (and honors minimize)', () => {
    const r = run({
      experiments: [exp({ id: 'a', score: 0.5 }), exp({ id: 'b', score: 0.9 }), exp({ id: 'c' })],
    });
    expect(bestExperiment(r)?.id).toBe('b');
    const mins = run({ config: { minimizeMetric: true }, experiments: r.experiments });
    expect(bestExperiment(mins)?.id).toBe('a');
    expect(bestExperiment(run({}))).toBeUndefined();
  });

  it('runStats derives the dashboard tiles', () => {
    const r = run({
      turns: 3,
      runtimeMs: 60_000,
      experiments: [
        exp({ id: 'a', score: 0.5, approach: 'boosting' }),
        exp({ id: 'b', score: 0.9, approach: 'boosting', metric: 'r2' }),
        exp({ id: 'c', status: 'failed', approach: 'nets' }),
        exp({ id: 'd', status: 'repaired', approach: 'nets' }),
        exp({ id: 'e', status: 'running' }),
      ],
    });
    const s = runStats(r, 0);
    expect(s.best).toBe(0.9);
    expect(s.bestMetric).toBe('r2');
    expect(s.experiments).toBe(5);
    // finished = a, b, c, d → ok = a, b, d
    expect(s.successRate).toBeCloseTo(3 / 4);
    expect(s.niches).toBeGreaterThanOrEqual(2);
    expect(s.repairs).toBe(1);
    expect(s.runtimeMs).toBe(60_000);
    expect(s.turns).toBe(3);
  });

  it('runStats has no success rate before anything finishes', () => {
    const r = run({ experiments: [exp({ id: 'a', status: 'running' })] });
    expect(runStats(r, 0).successRate).toBeUndefined();
  });

  it('layoutMaze orders a forest chronologically with branches below parents', () => {
    const r = run({
      bestExperimentId: 'c',
      experiments: [
        exp({ id: 'a', createdAt: 1 }),
        exp({ id: 'b', createdAt: 2, parentId: 'a' }),
        exp({ id: 'c', createdAt: 3, parentId: 'b', score: 0.9 }),
        exp({ id: 'd', createdAt: 4 }),
      ],
    });
    const nodes = layoutMaze(r);
    const byId = new Map(nodes.map((n) => [n.exp.id, n]));
    expect(byId.get('a')!.row).toBe(0);
    expect(byId.get('b')!.row).toBe(1);
    expect(byId.get('c')!.row).toBe(2);
    expect(byId.get('d')!.row).toBe(0);
    // DFS: a, b, c, then d — columns strictly increasing
    expect(nodes.map((n) => n.exp.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(nodes.map((n) => n.col)).toEqual([0, 1, 2, 3]);
    // best path: c ← b ← a highlighted, d not
    expect(byId.get('a')!.onBestPath).toBe(true);
    expect(byId.get('b')!.onBestPath).toBe(true);
    expect(byId.get('c')!.onBestPath).toBe(true);
    expect(byId.get('d')!.onBestPath).toBe(false);
  });

  it('layoutMaze tolerates orphaned parent ids', () => {
    const r = run({ experiments: [exp({ id: 'a', parentId: 'ghost' })] });
    const nodes = layoutMaze(r);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].row).toBe(0);
  });

  it('approach presets are well-formed and resolvable', () => {
    expect(APPROACH_PRESETS.length).toBeGreaterThanOrEqual(6);
    for (const a of APPROACH_PRESETS) {
      expect(a.id).toBeTruthy();
      expect(a.label).toBeTruthy();
      expect(a.blurb).toBeTruthy();
    }
    expect(new Set(APPROACH_PRESETS.map((a) => a.id)).size).toBe(APPROACH_PRESETS.length);
    expect(getApproach('automl-sweep')?.label).toMatch(/AutoML/);
    expect(getApproach('nope')).toBeUndefined();
  });

  it('formatRuntime renders human durations', () => {
    expect(formatRuntime(5 * 60_000)).toBe('5m');
    expect(formatRuntime(15 * 3_600_000)).toBe('15h');
    expect(formatRuntime(50 * 3_600_000)).toBe('2d 2h');
  });
});

describe('plan helpers (goal runs)', () => {
  const step = (partial: Partial<PlanStep> & { id: string }): PlanStep => ({
    title: partial.id,
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  });

  it('planProgress handles the no-plan case', () => {
    expect(planProgress(undefined)).toEqual({ total: 0, done: 0, skipped: 0, current: undefined, ratio: 0 });
    expect(planProgress([])).toEqual({ total: 0, done: 0, skipped: 0, current: undefined, ratio: 0 });
  });

  it('planProgress counts done + skipped toward completion', () => {
    const p = planProgress([
      step({ id: 's1', status: 'done' }),
      step({ id: 's2', status: 'skipped' }),
      step({ id: 's3', status: 'active' }),
      step({ id: 's4' }),
    ]);
    expect(p.total).toBe(4);
    expect(p.done).toBe(1);
    expect(p.skipped).toBe(1);
    expect(p.ratio).toBe(0.5);
  });

  it('planProgress picks the active step as current, else the first pending', () => {
    expect(planProgress([step({ id: 's1', status: 'done' }), step({ id: 's2', status: 'active' }), step({ id: 's3' })]).current?.id).toBe('s2');
    expect(planProgress([step({ id: 's1', status: 'done' }), step({ id: 's2' }), step({ id: 's3' })]).current?.id).toBe('s2');
    expect(planProgress([step({ id: 's1', status: 'done' }), step({ id: 's2', status: 'skipped' })]).current).toBeUndefined();
  });

  it('a fully worked plan reports ratio 1', () => {
    const p = planProgress([step({ id: 's1', status: 'done' }), step({ id: 's2', status: 'done' })]);
    expect(p.ratio).toBe(1);
    expect(p.current).toBeUndefined();
  });
});
