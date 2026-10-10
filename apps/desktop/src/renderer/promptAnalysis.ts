/**
 * Client-side prompt analysis, instant, offline, no API cost. Modeled on the
 * PromptLint diagnostics approach: detect the *parts* of a prompt, run lint
 * rules over the text, produce an A–F health grade, and suggest a model tier.
 * Pure functions; the composer renders the result.
 */

export type Severity = 'critical' | 'warn' | 'info';

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  /** Character range in the source text, when the finding points at a span. */
  start?: number;
  end?: number;
}

export interface PromptPart {
  id: string;
  label: string;
  present: boolean;
  hint: string;
}

export interface ModelHint {
  tier: 'frontier' | 'balanced' | 'fast';
  reason: string;
}

export interface PromptAnalysis {
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  score: number;
  parts: PromptPart[];
  findings: Finding[];
  tokens: number;
  model: ModelHint;
}

/** Rough token estimate (~4 chars/token), matching the app's other estimates. */
function estimateTokens(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

/** Push a finding for every match of `re` in `text`. */
function eachMatch(text: string, re: RegExp, make: (m: RegExpExecArray) => Finding, out: Finding[]): void {
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = r.exec(text))) {
    out.push(make(m));
    if (m.index === r.lastIndex) r.lastIndex++; // avoid zero-width loops
  }
}

const PART_DEFS: Array<{ id: string; label: string; hint: string; test: (t: string) => boolean }> = [
  { id: 'role', label: 'Role', hint: 'Give the model a persona ("You are a…").', test: (t) => /\b(you are|act as|you're an?|as an? expert|your role is)\b/i.test(t) },
  { id: 'task', label: 'Task', hint: 'State the task as a clear command.', test: (t) => /\b(write|create|generate|analy[sz]e|summari[sz]e|list|explain|implement|refactor|fix|debug|review|design|build|translate|extract|classify|compare|rewrite|draft|plan|outline)\b/i.test(t) },
  { id: 'context', label: 'Context', hint: 'Add background or reference material, set off with delimiters.', test: (t) => /```|"""|<[a-z_]+>|^#{1,6}\s|\b(context|background|given|reference)\s*:/im.test(t) },
  { id: 'examples', label: 'Examples', hint: 'Show one or two examples of what you want.', test: (t) => /\bexamples?\b|\be\.g\.|for instance|input\s*:|output\s*:/i.test(t) },
  { id: 'format', label: 'Format', hint: 'Specify the output shape (JSON, markdown, length…).', test: (t) => /\b(json|markdown|md|table|bullet(s| points)?|csv|yaml|xml|format|respond with|return (a|the)|schema|as a list|number(ed)? list|word(s)?|sentences?|paragraphs?)\b/i.test(t) },
  { id: 'constraints', label: 'Constraints', hint: 'State rules and limits (must / never / at most…).', test: (t) => /\b(must|do not|don't|never|only|at most|no more than|limit|avoid|should not|always|exclude|without)\b/i.test(t) },
];

const VAGUE = ['good', 'nice', 'appropriate', 'properly', 'some', 'several', 'things', 'stuff', 'better', 'high-quality', 'as needed', 'robust', 'clean', 'optimal', 'reasonable'];
const HEDGES = ['should be', 'could you', 'might want to', 'try to', 'maybe', 'perhaps', 'kind of', 'sort of', 'if possible'];
const FILLER = ['please note that', 'it is important to', 'as previously mentioned', 'in order to', 'due to the fact that', 'needless to say', 'as a matter of fact'];

const SECRET_RES: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{20,}/g, 'OpenAI-style API key'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API key'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS access key'],
  [/ghp_[A-Za-z0-9]{30,}/g, 'GitHub token'],
  [/Bearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer token'],
  [/\b(api[_-]?key|secret|password|token)\s*[:=]\s*['"]?[A-Za-z0-9._-]{8,}/gi, 'credential'],
];

function wordList(words: string[]): RegExp {
  return new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
}

export function analyzePrompt(raw: string): PromptAnalysis {
  const text = raw ?? '';
  const findings: Finding[] = [];
  const tokens = estimateTokens(text);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  const parts = PART_DEFS.map((p) => ({ id: p.id, label: p.label, hint: p.hint, present: p.test(text) }));
  const has = (id: string) => parts.find((p) => p.id === id)?.present ?? false;

  // --- Structure / completeness ---
  if (!has('task')) findings.push({ ruleId: 'no-task', severity: 'warn', message: 'No clear task, start with a command verb (Write, Analyze, Fix…).' });
  if (!has('format') && words > 12) findings.push({ ruleId: 'no-format', severity: 'warn', message: 'No output format specified (e.g. JSON, markdown, a list, a length).' });
  if (!has('role') && words > 20) findings.push({ ruleId: 'no-role', severity: 'info', message: 'Consider adding a persona ("You are a…") to steer tone and expertise.' });
  if (/\b(classify|categori[sz]e|extract|label|tag)\b/i.test(text) && !has('examples')) {
    findings.push({ ruleId: 'no-examples', severity: 'info', message: 'Extraction/classification works far better with one or two examples.' });
  }

  // --- Vagueness & weak language (ranged) ---
  eachMatch(text, wordList(VAGUE), (m) => ({ ruleId: 'vague', severity: 'warn', message: `"${m[0]}" is vague, say specifically what you mean.`, start: m.index, end: m.index + m[0].length }), findings);
  eachMatch(text, wordList(HEDGES), (m) => ({ ruleId: 'hedge', severity: 'info', message: `"${m[0]}" is tentative, use a direct instruction.`, start: m.index, end: m.index + m[0].length }), findings);
  eachMatch(text, wordList(FILLER), (m) => ({ ruleId: 'filler', severity: 'info', message: `"${m[0]}" is filler, it wastes tokens.`, start: m.index, end: m.index + m[0].length }), findings);

  // --- Length ---
  if (tokens > 2000) findings.push({ ruleId: 'too-long', severity: 'warn', message: `Long prompt (~${tokens} tokens). Trim anything the model doesn't need.` });
  if (words > 0 && words < 8 && !has('format') && !has('constraints')) {
    findings.push({ ruleId: 'too-short', severity: 'info', message: 'Very short, likely underspecified. Add the task, context, and desired output.' });
  }
  // Long sentences (ranged).
  eachMatch(text, /[^.!?\n]{160,}?[.!?]/g, (m) => ({ ruleId: 'long-sentence', severity: 'info', message: 'Long sentence, splitting it improves clarity.', start: m.index, end: m.index + m[0].length }), findings);

  // --- Conflicts ---
  if (/\bconcise|brief|short\b/i.test(text) && /\b(detailed|comprehensive|thorough|in-depth|exhaustive)\b/i.test(text)) {
    findings.push({ ruleId: 'conflict-length', severity: 'warn', message: 'Conflicting length cues ("concise" vs "detailed"), pick one.' });
  }

  // --- Safety (ranged) ---
  for (const [re, label] of SECRET_RES) {
    eachMatch(text, re, (m) => ({ ruleId: 'secret', severity: 'critical', message: `Possible ${label} in the prompt, replace it with a placeholder.`, start: m.index, end: m.index + m[0].length }), findings);
  }
  eachMatch(text, /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => ({ ruleId: 'pii-email', severity: 'info', message: 'Email address detected, consider a placeholder for privacy.', start: m.index, end: m.index + m[0].length }), findings);

  // --- Score & grade ---
  const penalty = findings.reduce((s, f) => s + (f.severity === 'critical' ? 30 : f.severity === 'warn' ? 9 : 3), 0);
  const score = Math.max(0, 100 - penalty);
  const grade: PromptAnalysis['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';

  // --- Model hint ---
  const reasoningHeavy = /\b(step by step|reason|think through|chain of thought|prove|derive|plan then)\b/i.test(text);
  const constraintCount = (text.match(/\b(must|do not|don't|never|only|at most|no more than|avoid|always)\b/gi) ?? []).length;
  const codeHeavy = /```/.test(text);
  let model: ModelHint;
  if (tokens > 800 || reasoningHeavy || constraintCount >= 3 || (codeHeavy && tokens > 300)) {
    model = { tier: 'frontier', reason: 'Multi-step reasoning or lots of context, a frontier model will follow it most reliably.' };
  } else if (words > 0 && tokens < 120 && constraintCount === 0 && !codeHeavy) {
    model = { tier: 'fast', reason: 'Short and single-shot, a fast, cheap model is plenty.' };
  } else {
    model = { tier: 'balanced', reason: 'Moderate complexity, a balanced mid-tier model fits well.' };
  }

  return { grade, score, parts, findings, tokens, model };
}

// --- Part fill suggestions ---------------------------------------------------
// Powers the click-to-fill behavior of the composer's missing-part chips: for a
// part the prompt lacks, produce a starter snippet tailored to what the prompt
// is about (code, writing, data…), via plain text matching so it stays instant
// and offline. Each snippet is worded to satisfy that part's detector above.

export interface PartFill {
  snippet: string;
  /** Where the snippet belongs in the draft. */
  placement: 'start' | 'end';
}

/** Rough topic of the prompt, used to pick the best-matching snippet. */
function promptDomain(t: string): 'code' | 'writing' | 'data' | 'general' {
  if (/```|\b(bug|error|stack trace|refactor|function|component|endpoint|api|code|typescript|javascript|python|rust|test|compile|repo|commit)\b/i.test(t)) return 'code';
  if (/\b(email|blog|article|post|essay|copy|announcement|newsletter|headline|tweet|caption|story)\b/i.test(t)) return 'writing';
  if (/\b(data|csv|json|rows|dataset|spreadsheet|metrics|numbers|report|chart|trend)\b/i.test(t)) return 'data';
  return 'general';
}

const ROLE_FILL: Record<ReturnType<typeof promptDomain>, string> = {
  code: 'You are a senior software engineer who writes precise, minimal changes.',
  writing: 'You are an experienced editor with a sharp, plain-language style.',
  data: 'You are a meticulous data analyst who shows their working.',
  general: 'You are an expert in this domain.',
};
const TASK_FILL: Record<ReturnType<typeof promptDomain>, string> = {
  code: 'Fix the issue described above and explain the root cause.',
  writing: 'Draft the text described above.',
  data: 'Analyze the data above and summarize the key findings.',
  general: 'Write a response that addresses the request above.',
};
const FORMAT_FILL: Record<ReturnType<typeof promptDomain>, string> = {
  code: 'Format: markdown, with code in fenced blocks and a one-line summary first.',
  writing: 'Format: markdown, with a short title and two or three tight paragraphs.',
  data: 'Format: a markdown table of the findings, then three bullet takeaways.',
  general: 'Format: a short markdown answer with bullet points for the key items.',
};
const CONSTRAINTS_FILL: Record<ReturnType<typeof promptDomain>, string> = {
  code: 'Constraints: keep the diff minimal; do not touch unrelated code; note any tradeoffs.',
  writing: 'Constraints: at most 200 words; plain language; no filler.',
  data: 'Constraints: only conclusions the data supports; do not invent numbers; at most 5 bullets.',
  general: 'Constraints: be specific; do not invent facts; at most 5 bullet points.',
};

/**
 * A starter snippet for a missing prompt part, matched to the prompt's topic.
 * Returns null for unknown part ids (or parts with no sensible fill).
 */
export function suggestPartFill(partId: string, text: string): PartFill | null {
  const d = promptDomain(text);
  const isQuestion = /\?|^\s*(why|how|what|when|where|who)\b/i.test(text);
  switch (partId) {
    case 'role':
      return { snippet: ROLE_FILL[d], placement: 'start' };
    case 'task':
      return { snippet: isQuestion ? 'Explain the answer clearly, step by step.' : TASK_FILL[d], placement: 'end' };
    case 'context':
      return { snippet: 'Context:\n"""\n[paste the relevant background, code, or reference material here]\n"""', placement: 'end' };
    case 'examples':
      return { snippet: 'Example:\nInput: [a sample input]\nOutput: [what you expect back]', placement: 'end' };
    case 'format':
      return { snippet: /\b(classify|categori[sz]e|extract|label|tag)\b/i.test(text)
        ? 'Format: return valid JSON only, e.g. { "items": [] }.'
        : FORMAT_FILL[d], placement: 'end' };
    case 'constraints':
      return { snippet: CONSTRAINTS_FILL[d], placement: 'end' };
    default:
      return null;
  }
}

export const GRADE_COLOR: Record<PromptAnalysis['grade'], string> = {
  A: 'var(--success)', B: '#7bc86c', C: 'var(--warning)', D: '#e0823a', F: 'var(--danger)',
};
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: 'var(--danger)', warn: 'var(--warning)', info: 'var(--info)',
};

// --- Project / folder mention detection ------------------------------------
// Powers the composer's "what this will reference" highlight: find where the
// prompt names a known project (by folder name) or a folder path, so the UI can
// underline it and surface the guidelines/specs each one drags into context.

/** A known project the prompt might mention (a workspace folder). */
export interface MentionProject {
  id: string;
  /** Display name of the workspace. */
  name: string;
  /** Last path segment of the workspace folder. */
  base: string;
}

export interface MentionMatch {
  /** Workspace id when the mention maps to a known project, else null. */
  workspaceId: string | null;
  text: string;
  start: number;
  end: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Which known project (if any) a folder path token belongs to. */
function matchWorkspaceForPath(token: string, projects: MentionProject[]): string | null {
  const segs = token.replace(/^[@~]+/, '').split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
  if (segs.length === 0) return null;
  for (const p of projects) {
    const key = (p.base || p.name).toLowerCase();
    if (key.length >= 2 && segs.includes(key)) return p.id;
  }
  return null;
}

/**
 * Find, in order and without overlaps, every span of the prompt that names a
 * known project (by name or folder basename) or looks like a folder path. Runs
 * client-side on every keystroke, so it stays cheap and dependency-free.
 */
export function detectFolderMentions(text: string, projects: MentionProject[]): MentionMatch[] {
  const out: MentionMatch[] = [];
  const overlaps = (s: number, e: number) => out.some((m) => s < m.end && e > m.start);
  const push = (workspaceId: string | null, s: number, e: number) => {
    if (e <= s || overlaps(s, e)) return;
    out.push({ workspaceId, text: text.slice(s, e), start: s, end: e });
  };

  // 1) Known projects, matched by name or folder basename as a whole token.
  //    Longest term first so "nekko-dojo" wins over a bare "agent-nekko".
  const terms: Array<{ id: string; term: string }> = [];
  for (const p of projects) {
    for (const term of new Set([p.name, p.base].filter((t): t is string => typeof t === 'string' && t.trim().length >= 3))) {
      terms.push({ id: p.id, term: term.trim() });
    }
  }
  terms.sort((a, b) => b.term.length - a.term.length);
  for (const { id, term } of terms) {
    // Not preceded/followed by a word char, slash, or hyphen — so it's a
    // standalone reference, not a substring or a path segment (rule 2 owns paths).
    const re = new RegExp(`(?<![\\w/\\\\.-])${escapeRegExp(term)}(?![\\w-])`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      push(id, m.index, m.index + m[0].length);
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  // 2) Explicit folder / path tokens (foo/bar, ./x, ../x, /abs, ~/x, @path).
  //    Requires a real path signal so prose like "and/or" is left alone.
  const pathRe = /(?:@|~\/|\.{1,2}\/|\/)?[\w.-]+(?:[\\/][\w.-]+)*[\\/]?/g;
  let pm: RegExpExecArray | null;
  while ((pm = pathRe.exec(text))) {
    const tok = pm[0];
    if (pm.index === pathRe.lastIndex) pathRe.lastIndex++;
    if (!/[\\/]/.test(tok)) continue; // must contain a separator
    if (/^https?:\/\//i.test(tok)) continue; // skip URLs
    if (pm.index > 0 && text[pm.index - 1] === '/') continue; // mid-URL tail (…://host/…)
    const segs = tok.split(/[\\/]/).filter(Boolean);
    if (segs.every((s) => /^\d+$/.test(s))) continue; // dates / ratios like 2026/07/24
    const hasSignal =
      /^(?:@|~\/|\.{1,2}\/|\/)/.test(tok) || // leading ./ ../ / ~/ @
      /[\\/]$/.test(tok) || // trailing slash
      /\.[a-z0-9]+(?:[\\/]|$)/i.test(tok) || // a dotted filename segment
      segs.length >= 3; // clearly a path (a/b/c)
    if (!hasSignal) continue;
    push(matchWorkspaceForPath(tok, projects), pm.index, pm.index + tok.length);
  }

  return out.sort((a, b) => a.start - b.start);
}
