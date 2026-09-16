import { describe, expect, it } from 'vitest';
import {
  addPlanStep,
  decomposePrompt,
  movePlanStep,
  planAsPromptBlock,
  planFromPrompt,
  planProgressCount,
  removePlanStep,
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

describe('planAsPromptBlock', () => {
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
