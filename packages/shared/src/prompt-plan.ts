/**
 * The plan a prompt implies, decoded before anything runs.
 *
 * A prompt like "fix the limits bug, then add a test and open a PR" is three
 * pieces of work, but the agent only reveals that after it has already started
 * down one path. Decoding the prompt up front gives the user something to look
 * at *and argue with*: the steps are editable, so "no, don't open a PR" is a
 * click rather than an interruption two minutes in.
 *
 * Deliberately a pure heuristic, no model call: it has to be instant, offline,
 * and free, because it runs on every keystroke in the composer. The agent is
 * not bound by it; the plan is sent as guidance when the user asks for it to be.
 */

/** Status of one planned step. */
export type PromptStepStatus = 'pending' | 'running' | 'done' | 'skipped';

/** One step of the plan for the current prompt. */
export interface PromptPlanStep {
  id: string;
  text: string;
  status: PromptStepStatus;
  /** Title of the sub-agent that owns this step, when one was delegated it. */
  agent?: string;
}

/** The whole plan parked on a session. */
export interface PromptPlan {
  /** The prompt text this plan was decoded from, so a rewrite can be detected. */
  source: string;
  steps: PromptPlanStep[];
  /** Whether the plan is sent to the agent with the next message. */
  send: boolean;
  /** True once the user has edited it, so re-decoding stops overwriting them. */
  edited?: boolean;
}

const MAX_STEPS = 8;
const MIN_STEP_CHARS = 8;

/** Lines that are list items: "1. do x", "- do x", "* do x", "1) do x". */
const LIST_RE = /^\s*(?:[-*•]|\d{1,2}[.)])\s+(.*\S)\s*$/;

/**
 * Connectives that genuinely separate two pieces of work in one sentence.
 * Kept tight on purpose: splitting on every "and" turns "read and summarize the
 * file" into two steps that aren't.
 */
const SEQUENCE_RE = /,?\s*(?:\bthen\b|\bafter that\b|\bnext,\b|\bfinally,?\b|\blastly,?\b|\band then\b)\s*/i;

/** Verbs that start an instruction, used to tell work apart from context. */
const IMPERATIVE_RE =
  /^(?:please\s+)?(?:add|build|change|check|clean|create|debug|delete|deploy|design|document|drop|extend|extract|fix|implement|improve|investigate|make|merge|migrate|move|open|optimi[sz]e|refactor|remove|rename|replace|review|rewrite|run|ship|split|test|update|upgrade|verify|write|wire|switch|support|show|surface|track|handle)\b/i;

/**
 * Trim a step to one clean line of sentence case. The trailing conjunction
 * matters: splitting "rename it, then update imports, and finally open a PR"
 * leaves the middle piece ending in ", and", which reads like a truncation bug.
 */
function tidy(text: string): string {
  const t = text
    .replace(/^\s*(?:please\s+)?(?:can you|could you|i want you to|i'd like you to|let's)\s+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;.]*\b(?:and|but|so|then|plus)\s*$/i, '')
    .replace(/^[\s,;]*(?:and|but|so|then|also|plus)\b\s*/i, '')
    .replace(/[.;,]+$/, '')
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

let seq = 0;
function stepId(): string {
  seq += 1;
  return `ps_${Date.now().toString(36)}_${seq.toString(36)}`;
}

/**
 * Break a prompt into the steps it asks for.
 *
 * Structure wins when the prompt has it: an explicit list is the user's own
 * decomposition and is never second-guessed. Otherwise sentences that read as
 * instructions become steps, and a prompt with no instruction shape at all
 * stays a single step rather than being chopped into fragments.
 */
export function decomposePrompt(prompt: string): string[] {
  const text = prompt.trim();
  if (!text) return [];

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const listItems = lines.map((l) => LIST_RE.exec(l)?.[1]).filter((x): x is string => !!x);
  if (listItems.length >= 2) {
    return listItems.map(tidy).filter((s) => s.length >= MIN_STEP_CHARS).slice(0, MAX_STEPS);
  }

  // Sentences, then sequence connectives inside each one.
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .flatMap((s) => s.split(SEQUENCE_RE))
    .map((s) => s.trim())
    .filter(Boolean);

  const instructions = sentences.filter((s) => IMPERATIVE_RE.test(s.replace(/^(?:please\s+)?(?:can you|could you|i want you to|i'd like you to|let's)\s+/i, '')));
  const chosen = instructions.length >= 2 ? instructions : [text];
  return chosen.map(tidy).filter((s) => s.length >= MIN_STEP_CHARS).slice(0, MAX_STEPS);
}

/** Decode a prompt into a fresh plan (all steps pending, sending off by default). */
export function planFromPrompt(prompt: string): PromptPlan {
  return {
    source: prompt,
    steps: decomposePrompt(prompt).map((text) => ({ id: stepId(), text, status: 'pending' as const })),
    send: false,
  };
}

/** Append an empty step, for the rail's "Add step" affordance. */
export function addPlanStep(plan: PromptPlan, text = ''): PromptPlan {
  return { ...plan, edited: true, steps: [...plan.steps, { id: stepId(), text, status: 'pending' }] };
}

/** Replace one step's fields, marking the plan as hand-edited. */
export function updatePlanStep(plan: PromptPlan, id: string, patch: Partial<PromptPlanStep>): PromptPlan {
  return {
    ...plan,
    edited: true,
    steps: plan.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
}

/** Drop a step. */
export function removePlanStep(plan: PromptPlan, id: string): PromptPlan {
  return { ...plan, edited: true, steps: plan.steps.filter((s) => s.id !== id) };
}

/** Move a step one place up or down. */
export function movePlanStep(plan: PromptPlan, id: string, delta: -1 | 1): PromptPlan {
  const i = plan.steps.findIndex((s) => s.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= plan.steps.length) return plan;
  const steps = [...plan.steps];
  [steps[i], steps[j]] = [steps[j], steps[i]];
  return { ...plan, edited: true, steps };
}

/** How far through the plan the run is. */
export function planProgressCount(plan: PromptPlan | undefined): { done: number; total: number } {
  const steps = plan?.steps ?? [];
  return { done: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: steps.length };
}

/**
 * The plan as a block appended to the outgoing message. Skipped steps are sent
 * as explicit exclusions: "don't do this part" is the most useful thing a user
 * can say to a plan, and dropping the step silently would lose it.
 */
export function planAsPromptBlock(plan: PromptPlan | undefined): string {
  const steps = plan?.steps.filter((s) => s.text.trim()) ?? [];
  if (!steps.length) return '';
  const wanted = steps.filter((s) => s.status !== 'skipped');
  const skipped = steps.filter((s) => s.status === 'skipped');
  const lines = [
    'Work to this plan (the user reviewed and edited it):',
    ...wanted.map((s, i) => `${i + 1}. ${s.text.trim()}`),
  ];
  if (skipped.length) {
    lines.push('', 'Explicitly out of scope:', ...skipped.map((s) => `- ${s.text.trim()}`));
  }
  return lines.join('\n');
}
