import { describe, expect, it } from 'vitest';
import {
  addPlanStep,
  decomposePrompt,
  insertPlanStep,
  mergePlanStepUp,
  movePlanStep,
  planAsPromptBlock,
  planFromPrompt,
  planProgressCount,
  removePlanStep,
  reorderPlanStep,
  assignPlanStep,
  updatePlanStep,
} from './prompt-plan.js';

describe('decomposePrompt', () => {
  it('takes an explicit list as the user’s own decomposition', () => {
    const steps = decomposePrompt('Do these:\n1. Fix the limits parser\n2. Add a regression test\n3. Open a PR');
    expect(steps).toEqual(['Fix the limits parser', 'Add a regression test', 'Open a PR']);
  });

  it('handles bullets as well as numbers', () => {
    expect(decomposePrompt('- Rename the module\n- Update every import')).toEqual([
      'Rename the module',
      'Update every import',
    ]);
  });

  it('splits a sentence on sequence words', () => {
    expect(decomposePrompt('Fix the scaling bug, then add a test for it')).toEqual([
      'Fix the scaling bug',
      'Add a test for it',
    ]);
  });

  it('splits several instruction sentences', () => {
    expect(decomposePrompt('Update the picker. Write a test for the new rows.')).toEqual([
      'Update the picker',
      'Write a test for the new rows',
    ]);
  });

  it('keeps a single ask whole rather than chopping it into fragments', () => {
    const one = decomposePrompt('Read the file and summarize what it does for me');
    expect(one).toHaveLength(1);
    expect(one[0]).toBe('Read the file and summarize what it does for me');
  });

  it('keeps a question as one step', () => {
    expect(decomposePrompt('Why does the gauge stop updating mid-turn?')).toHaveLength(1);
  });

  it('strips polite wrappers from the first step', () => {
    expect(decomposePrompt('Could you fix the parser, then update the test')[0]).toBe('Fix the parser');
  });

  it('leaves no dangling conjunction when a split lands mid-list', () => {
    expect(decomposePrompt('Rename the limits module, then update every import, and finally open a PR')).toEqual([
      'Rename the limits module',
      'Update every import',
      'Open a PR',
    ]);
  });

  it('returns nothing for an empty prompt', () => {
    expect(decomposePrompt('   ')).toEqual([]);
  });

  it('caps a very long list', () => {
    const list = Array.from({ length: 20 }, (_, i) => `${i + 1}. Do the thing number ${i}`).join('\n');
    expect(decomposePrompt(list)).toHaveLength(8);
  });
});

describe('plan editing', () => {
  it('decodes, then survives every edit as hand-edited', () => {
    let plan = planFromPrompt('Fix the parser, then add a test');
    expect(plan.steps.map((s) => s.text)).toEqual(['Fix the parser', 'Add a test']);
    expect(plan.edited).toBeUndefined();

    plan = addPlanStep(plan, 'Open a PR');
    expect(plan.edited).toBe(true);
    expect(plan.steps).toHaveLength(3);

    plan = movePlanStep(plan, plan.steps[2].id, -1);
    expect(plan.steps.map((s) => s.text)).toEqual(['Fix the parser', 'Open a PR', 'Add a test']);

    plan = updatePlanStep(plan, plan.steps[1].id, { status: 'skipped' });
    expect(plan.steps[1].status).toBe('skipped');

    plan = removePlanStep(plan, plan.steps[0].id);
    expect(plan.steps).toHaveLength(2);
  });

  it('refuses to move a step off either end', () => {
    const plan = planFromPrompt('- One thing here\n- Another thing here');
    expect(movePlanStep(plan, plan.steps[0].id, -1)).toBe(plan);
    expect(movePlanStep(plan, plan.steps[1].id, 1)).toBe(plan);
  });

  it('counts skipped steps as settled', () => {
    let plan = planFromPrompt('- Step one here\n- Step two here\n- Step three here');
    plan = updatePlanStep(plan, plan.steps[0].id, { status: 'done' });
    plan = updatePlanStep(plan, plan.steps[1].id, { status: 'skipped' });
    expect(planProgressCount(plan)).toEqual({ done: 2, total: 3 });
  });
});

describe('typing a plan', () => {
  it('inserts after a step rather than at the end, and names the new one', () => {
    const plan = planFromPrompt('- Fix the parser\n- Open a PR');
    const { plan: next, id } = insertPlanStep(plan, plan.steps[0].id, 'Add a test');
    expect(next.steps.map((s) => s.text)).toEqual(['Fix the parser', 'Add a test', 'Open a PR']);
    expect(next.steps[1].id).toBe(id);
    expect(next.edited).toBe(true);
  });

  it('appends when the step it was given is gone', () => {
    const plan = planFromPrompt('- Fix the parser\n- Open a PR');
    const { plan: next } = insertPlanStep(plan, 'no-such-step', 'Add a test');
    expect(next.steps[next.steps.length - 1].text).toBe('Add a test');
  });

  it('merges a step into the one above and says where the caret lands', () => {
    const plan = planFromPrompt('- Fix the parser\n- Open a PR');
    const { plan: next, id, caret } = mergePlanStepUp(plan, plan.steps[1].id);
    expect(next.steps).toHaveLength(1);
    expect(next.steps[0].text).toBe('Fix the parserOpen a PR');
    expect(id).toBe(plan.steps[0].id);
    // The join, so Backspace is undone by typing what was just removed.
    expect(caret).toBe('Fix the parser'.length);
  });

  it('leaves the first step alone: there is nothing above it', () => {
    const plan = planFromPrompt('- Fix the parser\n- Open a PR');
    const merged = mergePlanStepUp(plan, plan.steps[0].id);
    expect(merged.plan).toBe(plan);
    expect(merged.id).toBeUndefined();
  });
});

describe('reorderPlanStep', () => {
  // Step text has to clear the decomposer's minimum length to survive decoding.
  const plan = () =>
    planFromPrompt('- Fix the parser\n- Add a regression test\n- Update the docs\n- Open a pull request');
  const texts = ['Fix the parser', 'Add a regression test', 'Update the docs', 'Open a pull request'];

  it('moves a step to sit before another in one hop', () => {
    const p = plan();
    const moved = reorderPlanStep(p, p.steps[0].id, p.steps[3].id);
    expect(moved.steps.map((s) => s.text)).toEqual([texts[1], texts[2], texts[0], texts[3]]);
  });

  it('moves a step to the end when dropped past the last one', () => {
    const p = plan();
    const moved = reorderPlanStep(p, p.steps[0].id, null);
    expect(moved.steps.map((s) => s.text)).toEqual([texts[1], texts[2], texts[3], texts[0]]);
  });

  it('drags a later step upward', () => {
    const p = plan();
    const moved = reorderPlanStep(p, p.steps[3].id, p.steps[1].id);
    expect(moved.steps.map((s) => s.text)).toEqual([texts[0], texts[3], texts[1], texts[2]]);
  });

  it('is a no-op when a step is dropped onto itself', () => {
    const p = plan();
    expect(reorderPlanStep(p, p.steps[1].id, p.steps[1].id)).toBe(p);
  });

  it('marks the plan as hand-edited so it stops being re-decoded', () => {
    const p = plan();
    expect(reorderPlanStep(p, p.steps[0].id, null).edited).toBe(true);
  });
});

describe('assignPlanStep', () => {
  it('hands a step to a sub-agent and takes it back again', () => {
    const p = planFromPrompt('- Fix the parser\n- Add a test');
    const given = assignPlanStep(p, p.steps[1].id, 'test-writer');
    expect(given.steps[1].agent).toBe('test-writer');

    const taken = assignPlanStep(given, p.steps[1].id, undefined);
    expect(taken.steps[1].agent).toBeUndefined();
  });

  it('treats an empty name as no owner rather than an owner called ""', () => {
    const p = planFromPrompt('- Fix the parser\n- Add a test');
    expect(assignPlanStep(p, p.steps[0].id, '  ').steps[0].agent).toBeUndefined();
  });
});

describe('planAsPromptBlock', () => {
  it('tells the agent which steps were handed to a sub-agent', () => {
    let plan = planFromPrompt('- Fix the parser\n- Add a test');
    plan = assignPlanStep(plan, plan.steps[1].id, 'test-writer');
    const block = planAsPromptBlock(plan);
    expect(block).toContain('2. Add a test (delegate to a sub-agent: test-writer)');
    // An unassigned step stays a plain instruction.
    expect(block).toContain('1. Fix the parser');
    expect(block).not.toContain('1. Fix the parser (delegate');
  });

  it('sends the wanted steps in order and names what was cut', () => {
    let plan = planFromPrompt('- Fix the parser\n- Add a test\n- Open a PR');
    plan = updatePlanStep(plan, plan.steps[2].id, { status: 'skipped' });
    const block = planAsPromptBlock(plan);
    expect(block).toContain('1. Fix the parser');
    expect(block).toContain('2. Add a test');
    expect(block).toContain('Explicitly out of scope:');
    expect(block).toContain('- Open a PR');
    // The skipped step must not be renumbered back into the work list.
    expect(block).not.toContain('3. Open a PR');
  });

  it('is empty when there is no plan', () => {
    expect(planAsPromptBlock(undefined)).toBe('');
    expect(planAsPromptBlock({ source: '', steps: [], send: true })).toBe('');
  });
});
