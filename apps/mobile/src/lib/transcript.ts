/**
 * One transcript model for both kinds of chat: a computer's session (saved
 * messages plus a live overlay folded from `agent:event`s while a turn runs)
 * and a chat with the model on this phone. The screen renders `Block[]` and
 * never looks at where they came from.
 */
import type { AgentEvent, AskRequest, ChatMessage, ToolCall } from './protocol';

export type ToolStatus = 'running' | 'waiting' | 'ok' | 'error';

export type Block =
  | { kind: 'user'; id: string; text: string; at?: number; images?: number }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      reasoning?: string;
      streaming?: boolean;
      interrupted?: boolean;
    }
  | { kind: 'tool'; id: string; name: string; label: string; status: ToolStatus; output?: string };

export interface Approval {
  call: ToolCall;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/** What a running turn has produced so far, before the session is re-read. */
export interface LiveTurn {
  running: boolean;
  blocks: Block[];
  approval?: Approval;
  question?: AskRequest;
  error?: string;
  /** Tokens/sec of the last reply, when the host reported usage. */
  rate?: number;
}

export const idleTurn = (): LiveTurn => ({ running: false, blocks: [] });

/** Saved messages → blocks. Tool results attach to the call that asked for them. */
export function fromMessages(messages: ChatMessage[]): Block[] {
  const out: Block[] = [];
  const tools = new Map<string, Extract<Block, { kind: 'tool' }>>();
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ kind: 'user', id: m.id, text: m.skill ? `/${m.skill.name} ${m.skill.input}`.trim() : m.content, at: m.createdAt, images: m.images?.length || undefined });
    } else if (m.role === 'assistant') {
      if (m.content.trim() || m.reasoning?.trim()) {
        out.push({ kind: 'assistant', id: m.id, text: m.content, reasoning: m.reasoning || undefined, interrupted: m.interrupted });
      }
      for (const call of m.toolCalls ?? []) {
        const block: Extract<Block, { kind: 'tool' }> = { kind: 'tool', id: call.id, name: call.name, label: toolLabel(call), status: 'ok' };
        tools.set(call.id, block);
        out.push(block);
      }
    } else if (m.role === 'tool' && m.toolResult) {
      const block = tools.get(m.toolResult.toolCallId);
      if (block) {
        block.status = m.toolResult.isError ? 'error' : 'ok';
        block.output = clip(m.toolResult.output);
      }
    }
  }
  return out;
}

/** Fold one agent event into the live turn. Pure; returns a new object. */
export function applyEvent(turn: LiveTurn, e: AgentEvent): LiveTurn {
  switch (e.type) {
    case 'text':
    case 'reasoning': {
      const blocks = [...turn.blocks];
      let last = blocks[blocks.length - 1];
      if (!last || last.kind !== 'assistant') {
        last = { kind: 'assistant', id: `live-${blocks.length}`, text: '', streaming: true };
        blocks.push(last);
      }
      const next = { ...last, streaming: true };
      if (e.type === 'text') next.text += e.delta;
      else next.reasoning = (next.reasoning ?? '') + e.delta;
      blocks[blocks.length - 1] = next;
      return { ...turn, running: true, blocks };
    }
    case 'tool_call':
      return {
        ...turn,
        running: true,
        blocks: [...settle(turn.blocks), { kind: 'tool', id: e.call.id, name: e.call.name, label: toolLabel(e.call), status: 'running' }],
      };
    case 'tool_approval_required':
      return {
        ...turn,
        running: true,
        approval: { call: e.call, reason: e.reason, severity: e.severity },
        blocks: upsertTool(turn.blocks, e.call, 'waiting'),
      };
    case 'tool_result':
      return {
        ...turn,
        approval: turn.approval?.call.id === e.result.toolCallId ? undefined : turn.approval,
        blocks: turn.blocks.map((b) =>
          b.kind === 'tool' && b.id === e.result.toolCallId
            ? { ...b, status: e.result.isError ? 'error' : 'ok', output: clip(e.result.output) }
            : b,
        ),
      };
    case 'question':
      return { ...turn, running: true, question: e.request };
    case 'question_resolved':
      return turn.question?.callId === e.callId ? { ...turn, question: undefined } : turn;
    case 'usage':
      return e.outputMs && e.outputTokens ? { ...turn, rate: (e.outputTokens / e.outputMs) * 1000 } : turn;
    case 'done':
      return { ...turn, running: false, approval: undefined, question: undefined, blocks: settle(turn.blocks) };
    case 'error':
      return {
        ...turn,
        running: false,
        approval: undefined,
        question: undefined,
        blocks: settle(turn.blocks),
        // A user stop arrives as an error; it isn't one from the user's side.
        error: /^(stopped|aborted)$/i.test(e.message) ? undefined : e.message,
      };
    default:
      return turn;
  }
}

function settle(blocks: Block[]): Block[] {
  return blocks.map((b) => (b.kind === 'assistant' && b.streaming ? { ...b, streaming: false } : b));
}

function upsertTool(blocks: Block[], call: ToolCall, status: ToolStatus): Block[] {
  if (blocks.some((b) => b.kind === 'tool' && b.id === call.id)) {
    return blocks.map((b) => (b.kind === 'tool' && b.id === call.id ? { ...b, status } : b));
  }
  return [...settle(blocks), { kind: 'tool', id: call.id, name: call.name, label: toolLabel(call), status }];
}

/** Short human label for a tool call: the file, command or query it acts on. */
export function toolLabel(call: ToolCall): string {
  const i = call.input ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = i[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  };
  const detail = pick('command', 'path', 'file_path', 'pattern', 'query', 'url', 'name', 'prompt', 'task');
  const verb = TOOL_VERBS[call.name] ?? call.name.replace(/_/g, ' ');
  return detail ? `${verb} ${oneLine(detail, 80)}` : verb;
}

const TOOL_VERBS: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  list_dir: 'List',
  glob: 'Find',
  grep: 'Search',
  bash: 'Run',
  web_fetch: 'Fetch',
  web_search: 'Search the web for',
  spawn_agent: 'Delegate',
  ask_user: 'Ask',
};

function oneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clip(s: string, max = 4000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** What the chat list shows next to a computer's chat. */
export type Activity = 'running' | 'needs-you';

/** Track which chats are mid-run or waiting on the user, from the event stream. */
export function nextActivity(activity: Record<string, Activity>, e: AgentEvent): Record<string, Activity> {
  const cur = activity[e.sessionId];
  let next: Activity | undefined = cur;
  switch (e.type) {
    case 'tool_approval_required':
    case 'question':
      next = 'needs-you';
      break;
    case 'text':
    case 'reasoning':
    case 'tool_call':
    case 'tool_result':
    case 'question_resolved':
      next = 'running';
      break;
    case 'done':
    case 'error':
      next = undefined;
      break;
    default:
      return activity;
  }
  if (next === cur) return activity;
  const out = { ...activity };
  if (next) out[e.sessionId] = next;
  else delete out[e.sessionId];
  return out;
}

/**
 * Saved transcript + live overlay without duplicates. A session re-read in
 * the middle of a turn (reconnect, title change) may already hold part of
 * what the overlay streamed: our prompt, finished tools, replies the host
 * persisted. Only this turn's saved blocks count, the ones after our prompt,
 * so a reply or call id that repeats an earlier turn is never swallowed.
 */
export function mergeLive(saved: Block[], live: Block[]): Block[] {
  if (live.length === 0) return saved;
  const prompt = live.find((b) => b.kind === 'user');
  const lastUserAt = saved.map((b) => b.kind).lastIndexOf('user');
  const lastUser = lastUserAt >= 0 ? saved[lastUserAt] : undefined;
  // The overlay's prompt isn't saved yet, so nothing from this turn is.
  if (prompt && !(lastUser?.kind === 'user' && lastUser.text.trim() === (prompt.kind === 'user' ? prompt.text.trim() : ''))) {
    return [...saved, ...live];
  }
  const head = saved.slice(0, lastUserAt + 1);
  const turn = saved.slice(lastUserAt + 1);
  const toolIds = new Set(turn.filter((b) => b.kind === 'tool').map((b) => b.id));
  const replies = turn.flatMap((b) => (b.kind === 'assistant' ? [b.text.trim()] : []));
  const liveTools = new Map(live.flatMap((b) => (b.kind === 'tool' ? [[b.id, b] as const] : [])));
  const extra = live.filter((b) => {
    if (b.kind === 'user') return false; // it's the saved prompt
    if (b.kind === 'tool') return !toolIds.has(b.id);
    return !b.text.trim() || !replies.includes(b.text.trim());
  });
  // A saved tool row the overlay knows more about (waiting, newer output) wins.
  return [...head, ...turn.map((b) => (b.kind === 'tool' && liveTools.has(b.id) ? liveTools.get(b.id)! : b)), ...extra];
}
