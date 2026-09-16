import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, Session } from '@agent-nekko/shared';
import {
  addPlanStep,
  insertPlanStep,
  mergePlanStepUp,
  movePlanStep,
  planFromPrompt,
  planProgressCount,
  removePlanStep,
  updatePlanStep,
  type PromptStepStatus,
  type PromptPlan,
} from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { CheckIcon, ChatIcon, CloseIcon, ListIcon, PlusIcon, RobotIcon, WandIcon } from '../icons.js';

/**
 * The work rail: what this prompt is going to do, who is doing it, and how far
 * along it is. Sits to the right of the transcript, inside the chat pane.
 *
 * Three things a running agent hides, surfaced before and while it runs:
 *
 * - **The plan.** Decoded from the prompt the moment you type it, as an editable
 *   list. The point is the editing: disagreeing with the approach is a click
 *   here rather than an interruption once the agent is three tool calls deep.
 *   Every step is a live text field, so writing a plan is typing one — Enter
 *   starts the next step, Backspace on an empty one removes it, and the arrow
 *   keys walk the list — rather than a click into an edit mode per line.
 * - **Sub-agents.** Delegated work is a nested chat elsewhere in the sidebar,
 *   which is exactly where you aren't looking. Each one gets a row with what it
 *   is doing right now, and opens as a tab.
 * - **Queued prompts.** What runs after this turn, in order.
 */

const STATUS_META: Record<PromptStepStatus, { label: string; color: string }> = {
  pending: { label: 'Not started', color: 'var(--ink-faint)' },
  running: { label: 'In progress', color: 'var(--accent)' },
  done: { label: 'Done', color: 'var(--success)' },
  skipped: { label: 'Skipped, not in scope', color: 'var(--ink-faint)' },
};

/** Click order for a step's status dot: pending → done → skipped → pending. */
const NEXT_STATUS: Record<PromptStepStatus, PromptStepStatus> = {
  pending: 'done',
  running: 'done',
  done: 'skipped',
  skipped: 'pending',
};

export function PlanRail({
  sessionId,
  session,
  draft,
  streaming,
  onPlanChange,
  onClose,
}: {
  sessionId: string;
  session: Session | null;
  /** What's typed but unsent, so the plan tracks the prompt as it's written. */
  draft: string;
  streaming: boolean;
  onPlanChange: (plan: PromptPlan | undefined) => void;
  onClose: () => void;
}) {
  const plan = session?.plan;
  const sessions = useStore((s) => s.sessions);
  const openChatPane = useStore((s) => s.openChatPane);
  /** What the trailing "add a step" row has typed but not yet committed. */
  const [adding, setAdding] = useState('');
  /**
   * The step to put the cursor in, and where in it. A ref rather than state,
   * and retried after every render rather than once: a step created by Enter
   * does not exist yet when the key is handled, so a single attempt runs before
   * the input it is looking for has mounted and the caret is simply lost.
   */
  const pendingFocus = useRef<{ id: string; caret?: number } | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    const want = pendingFocus.current;
    if (!want) return;
    const el = inputs.current.get(want.id);
    if (!el) return; // Not mounted yet; the next render tries again.
    pendingFocus.current = null;
    el.focus();
    const caret = want.caret ?? el.value.length;
    el.setSelectionRange(caret, caret);
  });

  /**
   * Put the cursor in a step. Immediately when that step is already on screen —
   * walking the list with the arrow keys changes no state, so waiting for a
   * render that never comes would simply lose the keypress — and otherwise on
   * whichever render first mounts it.
   */
  const focusStep = (id: string, caret?: number) => {
    const el = inputs.current.get(id);
    if (!el) {
      pendingFocus.current = { id, caret };
      return;
    }
    el.focus();
    const at = caret ?? el.value.length;
    el.setSelectionRange(at, at);
  };

  // Re-decode as the prompt is written, but never over a plan the user has
  // touched: their edit is the whole point of the panel.
  const decodeSource = draft.trim();
  useEffect(() => {
    if (plan?.edited) return;
    if (!decodeSource) {
      if (plan && !plan.edited && plan.source !== '' && !streaming) onPlanChange(undefined);
      return;
    }
    if (plan?.source === decodeSource) return;
    const next = planFromPrompt(decodeSource);
    onPlanChange(next.steps.length ? { ...next, send: plan?.send ?? false } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decodeSource, plan?.edited, plan?.source, streaming]);

  const children = useMemo(
    () => sessions.filter((s) => s.parentSessionId === sessionId),
    [sessions, sessionId],
  );
  const activity = useSubAgentActivity(children.map((c) => c.id));

  const progress = planProgressCount(plan);
  const queued = session?.queue ?? [];

  const edit = (next: PromptPlan) => onPlanChange(next);

  /** Turn whatever the add row holds into a step. Blank text adds nothing. */
  const commitAdding = () => {
    const text = adding.trim();
    setAdding('');
    if (!text) return;
    edit(addPlanStep(plan ?? { source: decodeSource, steps: [], send: false }, text));
  };

  /**
   * The list's keyboard, which is the keyboard every other list has: Enter
   * splits at the caret and moves you down, Backspace at the start pulls the
   * step into the one above, the arrows walk between rows, and Alt with them
   * carries the step along.
   */
  const onStepKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, step: { id: string; text: string }, i: number) => {
    if (!plan) return;
    const el = e.currentTarget;
    const caret = el.selectionStart ?? el.value.length;
    const collapsed = caret === (el.selectionEnd ?? caret);

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Splitting at the caret keeps the halves; at the end it is just a new,
      // empty step, which is the common case.
      const before = step.text.slice(0, caret);
      const after = step.text.slice(caret);
      const withSplit = before === step.text ? plan : updatePlanStep(plan, step.id, { text: before });
      const { plan: next, id } = insertPlanStep(withSplit, step.id, after);
      edit(next);
      focusStep(id, 0);
      return;
    }

    if (e.key === 'Backspace' && collapsed && caret === 0) {
      if (!step.text) {
        e.preventDefault();
        edit(removePlanStep(plan, step.id));
        const previous = plan.steps[i - 1];
        if (previous) focusStep(previous.id);
        return;
      }
      if (i > 0) {
        e.preventDefault();
        const merged = mergePlanStepUp(plan, step.id);
        edit(merged.plan);
        if (merged.id) focusStep(merged.id, merged.caret);
      }
      return;
    }

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const delta = e.key === 'ArrowUp' ? -1 : 1;
      if (e.altKey) {
        e.preventDefault();
        edit(movePlanStep(plan, step.id, delta));
        focusStep(step.id, caret);
        return;
      }
      const neighbour = plan.steps[i + delta];
      if (!neighbour) return;
      e.preventDefault();
      focusStep(neighbour.id, Math.min(caret, neighbour.text.length));
    }
  };

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden border-l border-line"
      style={{ background: 'var(--paper)' }}
      aria-label="Plan and sub-agents"
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
        <ListIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          This prompt
        </span>
        <button
          className="shrink-0 rounded-sm p-1 text-ink-faint hover:text-ink"
          title="Hide the plan panel"
          aria-label="Hide the plan panel"
          onClick={onClose}
        >
          <CloseIcon className="h-3 w-3" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {/* ---- Plan ---- */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Plan</span>
            {progress.total > 0 && (
              <span className="text-[10px] tabular-nums text-ink-faint">{progress.done}/{progress.total}</span>
            )}
            {plan?.edited && (
              <span className="chip shrink-0 text-[9px]" title="You edited this plan, so it is no longer re-read from the prompt">
                yours
              </span>
            )}
          </div>

          {streaming && !plan?.steps.length ? (
            <p className="px-0.5 text-[11px] leading-snug text-ink-faint">No plan was set for this reply.</p>
          ) : (
            <ol className="space-y-0.5">
              {(plan?.steps ?? []).map((step, i) => (
                <li key={step.id} className="group flex items-start gap-1.5 rounded-lg px-1 py-0.5 hover:bg-surface-2">
                  <button
                    className="mt-[7px] shrink-0"
                    title={`${STATUS_META[step.status].label} — click to change`}
                    aria-label={`Step ${i + 1}: ${STATUS_META[step.status].label}`}
                    onClick={() => edit(updatePlanStep(plan!, step.id, { status: NEXT_STATUS[step.status] }))}
                  >
                    <StepDot status={step.status} />
                  </button>
                  <input
                    ref={(el) => {
                      if (el) inputs.current.set(step.id, el);
                      else inputs.current.delete(step.id);
                    }}
                    className={`plan-step min-w-0 flex-1 ${step.status === 'skipped' ? 'plan-step-skipped' : ''}`}
                    value={step.text}
                    placeholder="Untitled step"
                    aria-label={`Step ${i + 1}`}
                    spellCheck={false}
                    onChange={(e) => edit(updatePlanStep(plan!, step.id, { text: e.target.value }))}
                    onKeyDown={(e) => onStepKeyDown(e, step, i)}
                  />
                  {step.agent && (
                    <span className="mt-[5px] shrink-0 text-[10px] text-ink-faint" title={`Delegated to ${step.agent}`}>
                      {step.agent}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center self-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <button
                      className="rounded-sm px-0.5 text-[10px] text-ink-faint hover:text-ink disabled:opacity-30"
                      title="Move up (Alt+↑)"
                      aria-label={`Move step ${i + 1} up`}
                      disabled={i === 0}
                      onClick={() => edit(movePlanStep(plan!, step.id, -1))}
                    >
                      ↑
                    </button>
                    <button
                      className="rounded-sm px-0.5 text-[10px] text-ink-faint hover:text-ink disabled:opacity-30"
                      title="Move down (Alt+↓)"
                      aria-label={`Move step ${i + 1} down`}
                      disabled={i === plan!.steps.length - 1}
                      onClick={() => edit(movePlanStep(plan!, step.id, 1))}
                    >
                      ↓
                    </button>
                    <button
                      className="rounded-sm px-0.5 text-ink-faint hover:text-(--danger)"
                      title="Remove this step"
                      aria-label={`Remove step ${i + 1}`}
                      onClick={() => edit(removePlanStep(plan!, step.id))}
                    >
                      <CloseIcon className="h-2.5 w-2.5" />
                    </button>
                  </span>
                </li>
              ))}

              {/* The row you type into. It is always there, so adding a step is
                  typing rather than finding the button that lets you type.
                  What it holds is local state until Enter or a blur commits it:
                  a row that wrote every keystroke through the session and then
                  chased the caret into the step it had just created dropped
                  text whenever the round trip lost the race. */}
              <li className="flex items-start gap-1.5 rounded-lg px-1 py-0.5">
                <span className="mt-[7px] shrink-0 opacity-40">
                  <PlusIcon className="h-2.5 w-2.5 text-ink-faint" />
                </span>
                <input
                  className="plan-step min-w-0 flex-1"
                  value={adding}
                  placeholder={plan?.steps.length ? 'Add a step' : 'Type the first step, or just write your prompt'}
                  aria-label="Add a step"
                  spellCheck={false}
                  onChange={(e) => setAdding(e.target.value)}
                  onBlur={() => commitAdding()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      // Committed, and the cursor stays here for the next one:
                      // a plan is usually written several steps at a time.
                      e.preventDefault();
                      commitAdding();
                    } else if (e.key === 'Escape') {
                      setAdding('');
                    } else if ((e.key === 'Backspace' || e.key === 'ArrowUp') && !adding && plan?.steps.length) {
                      e.preventDefault();
                      focusStep(plan.steps[plan.steps.length - 1].id);
                    }
                  }}
                />
              </li>
            </ol>
          )}

          <div className="mt-1.5 flex items-center gap-1.5">
            {plan?.edited && (
              <button
                className="btn btn-ghost px-1.5 py-0.5 text-[11px]"
                title="Throw away your edits and read the plan back off the prompt"
                onClick={() => {
                  const fresh = planFromPrompt(decodeSource);
                  edit(fresh.steps.length ? { ...fresh, send: plan.send } : { source: decodeSource, steps: [], send: plan.send });
                }}
              >
                <WandIcon className="h-3 w-3" /> Re-read prompt
              </button>
            )}
          </div>

          {!!plan?.steps.length && (
            <label
              className="mt-2 flex cursor-pointer items-start gap-1.5 rounded-lg px-1 py-1 hover:bg-surface-2"
              title="Send the plan with your message, so the agent works to these steps in this order"
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0 accent-(--accent)"
                checked={!!plan.send}
                onChange={(e) => edit({ ...plan, send: e.target.checked })}
              />
              <span className="text-[11px] leading-snug text-ink-soft">
                Send this plan with the message
                <span className="block text-[10px] text-ink-faint">Skipped steps go out as "don't do this".</span>
              </span>
            </label>
          )}
        </section>

        {/* ---- Sub-agents ---- */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Sub-agents</span>
            {children.length > 0 && <span className="text-[10px] tabular-nums text-ink-faint">{children.length}</span>}
          </div>
          {children.length === 0 ? (
            <p className="px-0.5 text-[11px] leading-snug text-ink-faint">
              None yet. Work this agent delegates shows up here with what each one is doing.
            </p>
          ) : (
            <div className="space-y-0.5">
              {children.map((c) => {
                const a = activity[c.id];
                return (
                  <button
                    key={c.id}
                    className="flex w-full items-start gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-surface-2"
                    onClick={() => openChatPane(c.id)}
                    title={`Open ${c.title}`}
                  >
                    <RobotIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate text-[12px] text-ink-soft">{c.title}</span>
                        {a?.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: 'var(--accent)' }} />}
                        {a?.failed && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--danger)' }} />}
                      </span>
                      <span className="block truncate text-[10px] text-ink-faint">
                        {subAgentSubtitle(c, a)}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* ---- Queued follow-ups ---- */}
        {queued.length > 0 && (
          <section>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              After this · {queued.length}
            </div>
            <div className="space-y-0.5">
              {queued.map((q, i) => (
                <div key={i} className="flex items-start gap-1.5 px-1 py-0.5">
                  <ChatIcon className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint" title={q}>{q}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </aside>
  );
}

function StepDot({ status }: { status: PromptStepStatus }) {
  const meta = STATUS_META[status];
  if (status === 'done') {
    return (
      <span className="block" style={{ color: meta.color }}>
        <CheckIcon className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span
      className={`block h-2.5 w-2.5 rounded-full border ${status === 'running' ? 'animate-pulse' : ''}`}
      style={{
        borderColor: meta.color,
        background: status === 'running' ? meta.color : 'transparent',
        opacity: status === 'skipped' ? 0.5 : 1,
      }}
    />
  );
}

/** What a sub-agent row says under its title. */
function subAgentSubtitle(child: Session, a: SubAgentActivity | undefined): string {
  if (a?.tool) return `Running ${a.tool}`;
  if (a?.running) return 'Working…';
  if (a?.failed) return 'Stopped on an error';
  const last = [...child.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  if (last) return last.content.trim().replace(/\s+/g, ' ').slice(0, 60);
  return 'Waiting to start';
}

interface SubAgentActivity {
  running: boolean;
  failed: boolean;
  /** The tool the sub-agent is running right now, when it is running one. */
  tool?: string;
}

/**
 * Live per-sub-agent state from the agent event stream. The sessions in the
 * store only refresh when a turn ends, which is precisely when the answer stops
 * being interesting; these events are what "what is it doing" actually means.
 */
function useSubAgentActivity(ids: string[]): Record<string, SubAgentActivity> {
  const [state, setState] = useState<Record<string, SubAgentActivity>>({});
  const idsKey = ids.join('|');
  const idsRef = useRef(ids);
  idsRef.current = ids;

  useEffect(() => {
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (!idsRef.current.includes(e.sessionId)) return;
      setState((prev) => {
        const cur = prev[e.sessionId] ?? { running: false, failed: false };
        let next: SubAgentActivity = cur;
        if (e.type === 'tool_call') next = { running: true, failed: false, tool: e.call.name };
        else if (e.type === 'tool_result') next = { ...cur, running: true, tool: undefined };
        else if (e.type === 'text' || e.type === 'reasoning') next = { running: true, failed: false, tool: cur.tool };
        else if (e.type === 'error') next = { running: false, failed: true };
        else if (e.type === 'done') next = { running: false, failed: false };
        else return prev;
        return { ...prev, [e.sessionId]: next };
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  return state;
}
