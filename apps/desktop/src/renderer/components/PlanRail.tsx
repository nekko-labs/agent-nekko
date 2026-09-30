import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, Session, SessionSummary } from '@agent-nekko/shared';
import {
  addPlanStep,
  insertPlanStep,
  mergePlanStepUp,
  movePlanStep,
  planFromPrompt,
  planProgressCount,
  removePlanStep,
  reorderPlanStep,
  assignPlanStep,
  updatePlanStep,
  summarizeToolCall,
  getStrategy,
  DEFAULT_ORCHESTRATION,
  planProgress,
  type PromptStepStatus,
  type PromptPlan,
} from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { CheckIcon, ChatIcon, CloseIcon, GripIcon, ListIcon, PlusIcon, RobotIcon, WandIcon } from '../icons.js';

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
  // Whether this agent is even allowed to delegate, which decides what an empty
  // sub-agent list means. `solo` withholds the tool, so "none yet" would be a
  // promise the settings have already ruled out.
  const orchestration = useStore((s) => s.settings?.orchestration);
  const spawnAllowed = getStrategy((orchestration ?? DEFAULT_ORCHESTRATION).strategy).allowsSpawn;
  /** What the trailing "add a step" row has typed but not yet committed. */
  const [adding, setAdding] = useState('');
  /**
   * The step being dragged, and the one it would land before (null = the end).
   * Held here rather than on each row so every row can draw the same single
   * insertion line, and so a drop that never lands can be cleaned up in one go.
   */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined);
  /** The step whose "hand this to a sub-agent" field is open. */
  const [assigning, setAssigning] = useState<string | null>(null);
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

  /**
   * Sub-agents of this chat, including ones that are still being born.
   *
   * A child is created on disk and starts streaming immediately, but the store's
   * session list only reloads when a turn *ends*, so a sub-agent could run to
   * completion without ever appearing here. `useSubAgentActivity` therefore asks
   * the store to re-read the moment it sees an event from a session it does not
   * recognise, which is what makes delegation visible while it is happening
   * rather than in hindsight.
   */
  const children = useMemo(
    () => sessions.filter((s) => s.parentSessionId === sessionId),
    [sessions, sessionId],
  );
  const activity = useSubAgentActivity(sessionId, children.map((c) => c.id));

  const progress = planProgressCount(plan);
  /**
   * The plan the agent published itself via update_plan — what it decided to
   * do after reading the request, kept live as it works. When present it leads
   * the rail; the editable list below stays what the prompt decodes to.
   */
  const agentPlan = session?.agentPlan;
  const agentProgress = planProgress(agentPlan);
  const queued = session?.queue ?? [];

  const edit = (next: PromptPlan) => onPlanChange(next);

  /** Turn whatever the add row holds into a step. Blank text adds nothing. */
  const commitAdding = () => {
    const text = adding.trim();
    setAdding('');
    if (!text) return;
    edit(addPlanStep(plan ?? { source: decodeSource, steps: [], send: false }, text));
  };

  /** Finish a drag, wherever it ended up, and clear the rail's drag state. */
  const endDrag = () => {
    setDragId(null);
    setDropBefore(undefined);
  };

  /**
   * Drop the dragged step at the marked position. A drag that ends on itself,
   * or with nothing marked, is a no-op rather than a reshuffle.
   */
  const commitDrag = () => {
    if (plan && dragId && dropBefore !== undefined) {
      edit(reorderPlanStep(plan, dragId, dropBefore));
    }
    endDrag();
  };

  /**
   * Which side of a row the pointer is on, so a drag marks the gap it is
   * nearest rather than always the one above. Without this, dropping onto the
   * bottom half of the last step could never mean "put it at the end".
   */
  const markDropTarget = (e: React.DragEvent, step: { id: string }, i: number) => {
    if (!dragId || !plan) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect();
    const below = e.clientY > r.top + r.height / 2;
    const next = below ? plan.steps[i + 1]?.id ?? null : step.id;
    if (next !== dropBefore) setDropBefore(next);
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
        {/* ---- Agent's plan ----
            Read-only: the agent owns it and keeps it current via update_plan.
            It answers "what is it doing" the way the editable list cannot — the
            editable list is your prompt's plan, this one is the agent's. */}
        {!!agentPlan?.length && (
          <section>
            <div className="mb-1.5 flex items-center gap-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Agent plan</span>
              <span className="text-[10px] tabular-nums text-ink-faint">
                {agentProgress.done + agentProgress.skipped}/{agentProgress.total}
              </span>
              {streaming && (
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full"
                  style={{ background: 'var(--accent)' }}
                  title="The agent is working"
                />
              )}
            </div>
            <ol className="space-y-0.5">
              {agentPlan.map((step) => (
                <li key={step.id} className="flex items-start gap-1.5 rounded-lg px-1 py-0.5">
                  <span className="mt-[5px] shrink-0">
                    <StepDot status={step.status === 'active' ? 'running' : step.status} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-[12px] leading-snug ${
                        step.status === 'skipped' ? 'text-ink-faint line-through' : 'text-ink-soft'
                      }`}
                    >
                      {step.title}
                    </span>
                    {step.note && (
                      <span className="block truncate text-[10px] text-ink-faint" title={step.note}>
                        {step.note}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-1 px-0.5 text-[10px] leading-snug text-ink-faint">
              What the agent decided after reading the request; it keeps this current as it works.
            </p>
          </section>
        )}

        {/* ---- Plan ---- */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {agentPlan?.length ? 'Your steps' : 'Plan'}
            </span>
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
                <li
                  key={step.id}
                  className={`group relative flex items-start gap-1.5 rounded-lg px-1 py-0.5 hover:bg-surface-2 ${
                    dragId === step.id ? 'opacity-40' : ''
                  }`}
                  onDragOver={(e) => markDropTarget(e, step, i)}
                  onDrop={(e) => { e.preventDefault(); commitDrag(); }}
                >
                  {/* The line the drop would insert at, drawn in that gap. */}
                  {dropBefore === step.id && (
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full"
                      style={{ background: 'var(--accent)' }}
                    />
                  )}
                  {/* The grip. Only the handle is draggable, so selecting text
                      inside a step stays a selection rather than a row drag. */}
                  <span
                    draggable
                    onDragStart={(e) => {
                      setDragId(step.id);
                      e.dataTransfer.effectAllowed = 'move';
                      // Firefox refuses to start a drag with no payload set.
                      e.dataTransfer.setData('text/plain', step.id);
                    }}
                    onDragEnd={endDrag}
                    className="mt-[6px] shrink-0 cursor-grab text-ink-faint opacity-0 transition-opacity active:cursor-grabbing group-hover:opacity-100"
                    title="Drag to reorder this step"
                    aria-label={`Reorder step ${i + 1}`}
                  >
                    <GripIcon className="h-3 w-3" />
                  </span>
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
                  {step.agent && assigning !== step.id && (
                    <button
                      className="mt-[4px] shrink-0 rounded-sm px-1 text-[10px]"
                      style={{ background: 'color-mix(in srgb, var(--accent-2) 16%, transparent)', color: 'var(--accent-2)' }}
                      title={`Delegated to ${step.agent} - click to change, or clear the field to take it back`}
                      aria-label={`Step ${i + 1} is delegated to ${step.agent}. Change who owns it.`}
                      onClick={() => setAssigning(step.id)}
                    >
                      {step.agent}
                    </button>
                  )}
                  {assigning === step.id && (
                    <input
                      autoFocus
                      className="plan-step mt-px w-24 shrink-0 text-[10px]"
                      defaultValue={step.agent ?? ''}
                      placeholder="sub-agent"
                      aria-label={`Who should do step ${i + 1}`}
                      spellCheck={false}
                      // Committed on blur as well as Enter, so clicking away
                      // keeps what was typed instead of quietly dropping it.
                      onBlur={(e) => {
                        edit(assignPlanStep(plan!, step.id, e.target.value));
                        setAssigning(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.currentTarget.blur();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setAssigning(null);
                        }
                      }}
                    />
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
                    {!step.agent && (
                      <button
                        className="rounded-sm px-0.5 text-ink-faint hover:text-(--accent-2)"
                        title="Hand this step to a sub-agent"
                        aria-label={`Delegate step ${i + 1} to a sub-agent`}
                        onClick={() => setAssigning(step.id)}
                      >
                        <RobotIcon className="h-2.5 w-2.5" />
                      </button>
                    )}
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
              <li
                className="relative flex items-start gap-1.5 rounded-lg px-1 py-0.5"
                // Dropping below the last step means "put it at the end", so the
                // add row is the target for that gap rather than a dead strip.
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dropBefore !== null) setDropBefore(null);
                }}
                onDrop={(e) => { e.preventDefault(); commitDrag(); }}
              >
                {dragId && dropBefore === null && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full"
                    style={{ background: 'var(--accent)' }}
                  />
                )}
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
            // An empty list has two very different causes, and "none yet" was
            // wrong for one of them: under the `solo` strategy `spawn_agent` is
            // withheld from the model entirely, so no amount of waiting will
            // ever put a row here. Say which it is, and where to change it.
            spawnAllowed ? (
              <p className="px-0.5 text-[11px] leading-snug text-ink-faint">
                None yet. Work this agent delegates shows up here with what each one is doing.
              </p>
            ) : (
              <p className="px-0.5 text-[11px] leading-snug text-ink-faint">
                Delegation is off for this agent, so it works everything itself. Settings →
                Orchestration turns sub-agents on.
              </p>
            )
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
function subAgentSubtitle(child: SessionSummary, a: SubAgentActivity | undefined): string {
  if (a?.tool) return a.detail ? `${a.tool} · ${a.detail}` : `Running ${a.tool}`;
  if (a?.running) return 'Working…';
  if (a?.failed) return 'Stopped on an error';
  if (child.lastReplyText) return child.lastReplyText.slice(0, 60);
  return 'Waiting to start';
}

interface SubAgentActivity {
  running: boolean;
  failed: boolean;
  /** The tool the sub-agent is running right now, when it is running one. */
  tool?: string;
  /** What that tool was pointed at, so the row says more than the tool's name. */
  detail?: string;
}

/**
 * Live per-sub-agent state from the agent event stream.
 *
 * Two jobs, and the second is the one that made delegation invisible. The
 * obvious one is tracking what each known child is doing, because the stored
 * sessions only refresh when a turn ends, which is precisely when the answer
 * stops being interesting.
 *
 * The other is **discovering** children. `spawn_agent` creates the child and
 * starts it streaming in the same breath, and nothing reloads the session list
 * until a turn finishes, so a short sub-agent could start, work and finish
 * without this rail ever learning it existed. Any event from a session we have
 * not seen before is therefore treated as "something was spawned": if the host
 * confirms it is a child of this chat, the store re-reads and the row appears
 * while the work is still happening.
 */
function useSubAgentActivity(parentId: string, ids: string[]): Record<string, SubAgentActivity> {
  const [state, setState] = useState<Record<string, SubAgentActivity>>({});
  const idsKey = ids.join('|');
  const idsRef = useRef(ids);
  idsRef.current = ids;
  /** Ids we have already asked the store about, so one spawn is one re-read. */
  const probed = useRef(new Set<string>());

  useEffect(() => {
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (!idsRef.current.includes(e.sessionId)) {
        // Unknown session: it may be a sub-agent this chat just spawned. Ask the
        // store to re-read once, and let the next render pick it up.
        if (e.sessionId === parentId || probed.current.has(e.sessionId)) return;
        probed.current.add(e.sessionId);
        void useStore.getState().refreshSessions();
        return;
      }
      setState((prev) => {
        const cur = prev[e.sessionId] ?? { running: false, failed: false };
        let next: SubAgentActivity = cur;
        if (e.type === 'tool_call') next = { running: true, failed: false, tool: e.call.name, detail: summarizeToolCall(e.call, 40) };
        else if (e.type === 'tool_result') next = { ...cur, running: true, tool: undefined, detail: undefined };
        else if (e.type === 'text' || e.type === 'reasoning') next = { running: true, failed: false, tool: cur.tool, detail: cur.detail };
        else if (e.type === 'error') next = { running: false, failed: true };
        else if (e.type === 'done') next = { running: false, failed: false };
        else return prev;
        return { ...prev, [e.sessionId]: next };
      });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, parentId]);

  return state;
}
