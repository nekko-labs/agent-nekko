import { BranchIcon, RobotIcon } from '../../icons.js';
import { truncateWords, type ToolCall } from '@agent-nekko/shared';

export function subagentSummary(call: ToolCall): string {
  const task = typeof call.input.task === 'string' ? call.input.task.replace(/\s+/g, ' ').trim() : '';
  return `Spawned subagent · ${task ? truncateWords(task, 100) : subagentTitle(call)}`;
}

export function subagentTitle(call: ToolCall): string {
  return typeof call.input.title === 'string' && call.input.title.trim() ? call.input.title.trim() : 'Subagent';
}

/** A fork and agent together distinguish delegation from ordinary tool work. */
export function SubagentCue() {
  return <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1 text-accent"><BranchIcon className="h-3.5 w-3.5" /><RobotIcon className="h-3.5 w-3.5" /></span>;
}
