import type { DownloadJob, DownloadState } from '@nekko-agent/shared';

/**
 * Folds the per-file download jobs of one model into one download.
 *
 * A catalog download is often several files: the weights (sometimes split into
 * shards), a vision projector, tokenizer and chat-template files. The host runs
 * each as its own job so they resume and fail independently, but to a person it
 * is one model, so the panel shows one row with the files listed beneath it,
 * each named for what it is and why it came along.
 */

export interface FileRole {
  /** Short title for the file row, e.g. "Model weights, part 2 of 2". */
  title: string;
  /** One line on what the file is for. */
  purpose: string;
  /** Sort key: the weights first, small helpers last. */
  order: number;
}

export interface DownloadGroup {
  /** Group id, or the job id for a job that stands alone. */
  id: string;
  label: string;
  /** Files in the group, main weights first. One entry for a standalone job. */
  jobs: DownloadJob[];
  state: DownloadState;
  receivedBytes: number;
  /** Known only once every unfinished file has reported its size. */
  totalBytes?: number;
  bytesPerSecond?: number;
  startedAt: number;
  /** The first failure's message, so the group row can say why. */
  message?: string;
}

const ACTIVE: ReadonlySet<DownloadState> = new Set(['queued', 'downloading', 'verifying']);

export function isActive(state: DownloadState): boolean {
  return ACTIVE.has(state);
}

/** What a model's file is for, from its name. */
export function fileRole(file: string, known?: string): FileRole {
  const name = (file.split('/').pop() ?? file).toLowerCase();
  if (known) return { title: known, purpose: KNOWN_ROLE_PURPOSE[known.toLowerCase()] ?? 'Needed alongside the model to run it.', order: 1 };

  if (/mmproj/.test(name)) {
    return { title: 'Vision projector', purpose: 'Lets the model see images. Text works without it.', order: 2 };
  }
  const shard = /-(\d{5})-of-(\d{5})\.(gguf|safetensors)$/.exec(name);
  if (shard) {
    const part = Number(shard[1]);
    const of = Number(shard[2]);
    return {
      title: `Model weights, part ${part} of ${of}`,
      purpose: `The model is split into ${of} files; ${of === 2 ? 'both' : `all ${of}`} are needed to load it.`,
      order: 0 + part / 1000,
    };
  }
  if (/\.(gguf|safetensors|bin)$/.test(name)) {
    return { title: 'Model weights', purpose: 'The model itself: everything it has learned.', order: 0 };
  }
  if (/^chat[_-]template\.(jinja|json)$/.test(name)) {
    return { title: 'Chat template', purpose: 'How a conversation is laid out for the model (roles, turns, tool calls).', order: 3 };
  }
  if (name === 'tokenizer_config.json') {
    return { title: 'Tokenizer settings', purpose: 'Special tokens and the chat template the tokenizer uses.', order: 4 };
  }
  if (['tokenizer.json', 'tokenizer.model', 'vocab.json', 'merges.txt', 'added_tokens.json', 'special_tokens_map.json'].includes(name)) {
    return { title: 'Tokenizer', purpose: 'How text is split into the tokens the model reads and writes.', order: 4 };
  }
  if (name === 'generation_config.json') {
    return { title: 'Generation defaults', purpose: "The publisher's recommended sampling settings (temperature, top-p).", order: 5 };
  }
  if (name === 'config.json') {
    return { title: 'Model config', purpose: "The model's architecture description, read by tools that load it.", order: 5 };
  }
  if (name === 'preprocessor_config.json' || name === 'processor_config.json') {
    return { title: 'Image preprocessing', purpose: 'How pictures are resized and normalised before the model sees them.', order: 5 };
  }
  return { title: 'Supporting file', purpose: 'Shipped with the model and needed by some tools that load it.', order: 6 };
}

const KNOWN_ROLE_PURPOSE: Record<string, string> = {
  vae: 'Turns the generated picture from its compressed form into pixels.',
  'text encoder': 'Reads the prompt and turns it into what the image model follows.',
};

/** Groups jobs by `group`, newest group first, files in role order. */
export function groupDownloads(jobs: DownloadJob[]): DownloadGroup[] {
  const byId = new Map<string, DownloadJob[]>();
  for (const job of jobs) {
    const key = job.group ?? job.id;
    const list = byId.get(key);
    if (list) list.push(job);
    else byId.set(key, [job]);
  }
  const groups = [...byId.entries()].map(([id, members]) => summarize(id, members));
  return groups.sort((a, b) => b.startedAt - a.startedAt);
}

function summarize(id: string, members: DownloadJob[]): DownloadGroup {
  const jobs = [...members].sort((a, b) => {
    // The job whose id is the group id is the one the user asked for.
    if (a.id === id) return -1;
    if (b.id === id) return 1;
    const ra = fileRole(a.file ?? a.label, a.role).order;
    const rb = fileRole(b.file ?? b.label, b.role).order;
    return ra - rb || (a.file ?? a.label).localeCompare(b.file ?? b.label);
  });
  const lead = jobs[0];
  const receivedBytes = jobs.reduce((n, j) => n + j.receivedBytes, 0);
  // A queued file has not reported its size yet; a total missing it would make
  // the bar jump backwards when it does, so it stays unknown until then.
  const totalKnown = jobs.every((j) => j.totalBytes !== undefined || j.state === 'done');
  const totalBytes = totalKnown ? jobs.reduce((n, j) => n + (j.totalBytes ?? j.receivedBytes), 0) : undefined;
  const rate = jobs.reduce((n, j) => n + (isActive(j.state) ? (j.bytesPerSecond ?? 0) : 0), 0);
  return {
    id,
    label: lead.groupLabel ?? lead.label,
    jobs,
    state: groupState(jobs.map((j) => j.state)),
    receivedBytes,
    totalBytes,
    bytesPerSecond: rate > 0 ? rate : undefined,
    startedAt: Math.min(...jobs.map((j) => j.startedAt)),
    message: jobs.find((j) => j.state === 'failed')?.message ?? (jobs.length === 1 ? lead.message : undefined),
  };
}

/** One state for the whole download: a failure anywhere is a failure, otherwise the least finished file wins. */
export function groupState(states: DownloadState[]): DownloadState {
  if (states.includes('failed')) return 'failed';
  if (states.includes('downloading')) return 'downloading';
  if (states.includes('verifying')) return 'verifying';
  if (states.includes('queued')) return 'queued';
  if (states.includes('cancelled')) return 'cancelled';
  return 'done';
}

/** Time left from the recent rate, omitted when either input is missing. */
export function eta(job: { totalBytes?: number; receivedBytes: number; bytesPerSecond?: number }): string | null {
  if (!job.totalBytes || !job.bytesPerSecond || job.bytesPerSecond < 1) return null;
  const seconds = (job.totalBytes - job.receivedBytes) / job.bytesPerSecond;
  if (seconds <= 0 || !Number.isFinite(seconds)) return null;
  if (seconds < 90) return `${Math.round(seconds)}s left`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m left`;
  return `${(seconds / 3600).toFixed(1)}h left`;
}
