import { memo } from 'react';
import { summarizeThought, summarizeToolCall, truncateWords, type LiveActivity } from '@agent-nekko/shared';
import { ToolProgressChip } from './ToolProgressChip.js';
import { toolQuietSince } from './toolProgress.js';
import { ChatIcon, RobotIcon, ThoughtIcon, ToolStepIcon } from '../../icons.js';
import { Markdown } from '../Markdown.js';
import type { Activity } from './transcript.js';
import { stepKey } from './transcript.js';
import { SubagentCue, subagentTitle } from './SubagentCue.js';
import { useRowState } from './rowState.js';

/**
 * A turn's working steps, as the sequence they actually were.
 *
 * This used to be one line — "Worked on 6 steps · read_file, grep" — that hid
 * the order behind a click, and the order is the interesting part: what the
 * model thought, what it did about it, what it found, what it did next. So each
 * step is its own numbered row, in order, one line each: a thought shows where
 * it landed, a tool shows what it was pointed at, narration shows its first
 * line. Every row still opens to its full content, and the whole run still
 * collapses to the old one-liner, so a 40-step turn doesn't take over the
 * transcript.
 */
export const ActivityGroup = memo(function ActivityGroup({ items, streaming = false, toolActivity }: { items: Activity[]; streaming?: boolean; toolActivity?: LiveActivity }) {
  // Open while the turn runs (watching it work is the point), folded away
  // afterwards so a finished transcript reads as answers. Remembered per row,
  // so scrolling a transcript row out of the window and back keeps it as left.
  const [open, setOpen] = useRowState('group-open', streaming);
  const tools = items.filter((it): it is Extract<Activity, { kind: 'tool' }> => it.kind === 'tool');
  const toolCount = tools.length;
  const agents = tools.filter((it) => it.call.name === 'spawn_agent');
  const summary = streaming
    ? (toolCount ? `Working · ${tools[tools.length - 1].call.name}` : 'Thinking')
    : (toolCount
        ? `Worked on ${items.length} step${items.length === 1 ? '' : 's'}`
        : 'Thought it through');
  return (
    <div className={`${streaming ? 'fade-in ' : ''}mt-1 font-mono text-[12px]`}>
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        {agents.length ? <SubagentCue /> : <ToolStepIcon className="h-3 w-3 shrink-0 text-accent" />}
        <span className="shrink-0 whitespace-nowrap font-medium text-ink-soft">{summary}</span>
        {!streaming && toolCount > 0 && agents.length === 0 && (
          <span className="min-w-0 truncate text-ink-faint">
            · {Array.from(new Set(tools.map((t) => t.call.name))).join(', ')}
          </span>
        )}
        {agents.length > 0 && <span className="min-w-0 truncate text-accent" title={agents.map(({ call }) => subagentTitle(call)).join(', ')}>· {agents.length} subagent{agents.length === 1 ? '' : 's'} · {agents.map(({ call }) => subagentTitle(call)).join(', ')}</span>}
        {streaming && <span className="dots" />}
        {!open && tools.map(({ call }) => {
          const since = toolQuietSince(toolActivity, call.id);
          return since === undefined ? null : <ToolProgressChip key={call.id} since={since} />;
        })}
      </button>
      {open && (
        <ol className="ml-[7px] mt-0.5 border-l border-line pl-2.5">
          {items.map((it, i) => (
            <StepRow
              key={stepKey(it, i)}
              index={i + 1}
              item={it}
              quietSince={it.kind === 'tool' ? toolQuietSince(toolActivity, it.call.id) : undefined}
              // The last row of a live run is the one happening now.
              live={streaming && i === items.length - 1}
            />
          ))}
        </ol>
      )}
    </div>
  );
});

/**
 * One step in the sequence: a numbered, single-line row that opens to the whole
 * thing. The headline is what a reader needs to follow the run without opening
 * anything, which for a thought means its conclusion, not its opening.
 */
function StepRow({ index, item, live, quietSince }: { index: number; item: Activity; live: boolean; quietSince?: number }) {
  const [open, setOpen] = useRowState(`step-${index}-open`, false);

  const kind =
    item.kind === 'tool' ? (item.call.name === 'spawn_agent' ? 'agent' : 'tool') : item.kind;
  const headline =
    item.kind === 'reasoning'
      ? summarizeThought(item.text) || 'Thought it through'
      : item.kind === 'note'
        ? truncateWords(item.text.replace(/\s+/g, ' ').trim(), 90)
        : summarizeToolCall(item.call);

  const label =
    item.kind === 'reasoning'
      ? live ? 'Thinking' : item.duration != null ? `Thought ${item.duration}s` : 'Thought'
      : item.kind === 'note'
        ? 'Said'
        : item.call.name;

  const icon =
    kind === 'reasoning' ? <ThoughtIcon className="h-3 w-3 shrink-0 text-ink-faint" />
      : kind === 'agent' ? <RobotIcon className="h-3 w-3 shrink-0 text-accent" />
        : kind === 'note' ? <ChatIcon className="h-3 w-3 shrink-0 text-ink-faint" />
          : <ToolStepIcon className="h-3 w-3 shrink-0 text-ink-faint" />;

  return (
    <li className={kind === 'agent' ? 'list-none border-l-2 border-accent/40 pl-2' : 'list-none'}>
      <button
        className="flex w-full items-baseline gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-4 shrink-0 text-right text-[10px] tabular-nums opacity-60">{index}</span>
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        <span className="self-center">{icon}</span>
        <span className={`shrink-0 font-medium ${live ? 'text-accent' : 'text-ink-soft'}`}>{label}</span>
        {headline && <span className="min-w-0 truncate">· {headline}</span>}
        {live && <span className="dots" />}
        {quietSince !== undefined && <ToolProgressChip since={quietSince} />}
      </button>
      {open && (
        kind === 'agent' && item.kind === 'tool' ? (
          <div className="ml-[34px] space-y-2 py-1 pl-2">
            <div className="flex items-center gap-1.5 text-accent"><SubagentCue /><span>To subagent · {subagentTitle(item.call)}</span></div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap text-ink-soft">{typeof item.call.input.task === 'string' ? item.call.input.task : JSON.stringify(item.call.input, null, 2)}</pre>
            <div className="flex items-center gap-1.5 text-accent"><SubagentCue /><span>{item.result?.isError ? 'Subagent failed' : item.result ? 'From subagent' : live ? 'Subagent running' : 'No subagent result recorded'}</span></div>
            {item.result && <div className="font-sans text-[13px] text-ink-soft"><Markdown text={item.result.output} /></div>}
          </div>
        ) : item.kind === 'note' ? (
          <div className="ml-[34px] border-l border-line py-0.5 pl-2 font-sans text-[13px] text-ink-soft">
            <Markdown text={item.text} />
          </div>
        ) : (
          <pre className="ml-[34px] mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap border-l border-line pl-2 text-[12px] leading-relaxed text-ink-faint">
            {item.kind === 'reasoning' ? item.text : JSON.stringify(item.call.input, null, 2)}
          </pre>
        )
      )}
    </li>
  );
}
