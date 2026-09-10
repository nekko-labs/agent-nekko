import React, { useEffect, useMemo, useState } from 'react';
import type { ContextItem, SpecDocStatus, WorkspaceFolder } from '@agent-nekko/shared';
import {
  analyzePrompt,
  detectFolderMentions,
  suggestPartFill,
  GRADE_COLOR,
  SEVERITY_COLOR,
  type Finding,
  type MentionMatch,
  type MentionProject,
  type PartFill,
  type Severity,
} from '../promptAnalysis.js';
import { CATEGORY } from '../tokens.js';
import { FolderIcon } from '../icons.js';

/**
 * Live prompt analyzer in the composer. Zero-latency, client-side: shows a health
 * grade, which parts of a good prompt are present/missing, inline-underlined weak
 * spots, concrete suggestions, and a model recommendation. It also spots the
 * projects, codebases, and folders the prompt names — highlighting them inline
 * and surfacing the context (folders, guidelines, specs) each one pulls in — so
 * you can see what the agent will actually reference before you send. A marketing
 * edge: "Kotrain helps you write the prompt," not just answer it.
 */
const SEV_ORDER: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

/** A single piece of context a mentioned project drags in. */
type RefKind = 'guideline' | 'spec' | 'file' | 'code';
interface ContextRef {
  kind: RefKind;
  label: string;
  /** Optional secondary text (e.g. a filename). */
  sub?: string;
}
const REF_META: Record<RefKind, { color: string; label: string }> = {
  guideline: { color: CATEGORY.guideline, label: 'Guideline' },
  spec: { color: CATEGORY.spec, label: 'Spec' },
  file: { color: CATEGORY.file, label: 'File' },
  code: { color: CATEGORY.index, label: 'Code index' },
};

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function normPath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}
function isUnder(origin: string, wsPath: string): boolean {
  if (!origin || !wsPath) return false;
  const o = normPath(origin);
  const w = normPath(wsPath);
  return o === w || o.startsWith(w + '/');
}
/** Filenames that read as spec-driven artifacts (spec.md, tasks.md, design.md…). */
function isSpecName(name: string): boolean {
  return /^(spec|tasks|requirements|design|plan|roadmap|prd)\b/i.test(name) || /\.spec\.md$/i.test(name);
}

export function PromptAnalyzer({
  text,
  sessionId,
  workspaces = [],
  contextItems = [],
  activeWorkspaceIds = [],
  onFill,
}: {
  text: string;
  sessionId?: string;
  workspaces?: WorkspaceFolder[];
  /** Items currently assembled into this chat's context (from the bundle). */
  contextItems?: ContextItem[];
  /** Workspace ids grounding this chat (primary + supporting). */
  activeWorkspaceIds?: string[];
  /** Insert a starter snippet for a missing part into the draft. */
  onFill?: (fill: PartFill) => void;
}) {
  const [open, setOpen] = useState(false);
  const [specDocs, setSpecDocs] = useState<Record<string, SpecDocStatus[]>>({});

  const a = useMemo(() => analyzePrompt(text), [text]);

  const projects = useMemo<MentionProject[]>(
    () => workspaces.map((w) => ({ id: w.id, name: w.name, base: baseName(w.path) })),
    [workspaces],
  );
  const mentions = useMemo(() => detectFolderMentions(text, projects), [text, projects]);

  // Mentioned known projects, in first-seen order.
  const mentionedIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const m of mentions) if (m.workspaceId && !seen.has(m.workspaceId)) { seen.add(m.workspaceId); ids.push(m.workspaceId); }
    return ids;
  }, [mentions]);
  const mentionKey = mentionedIds.join(',');

  // Mentioned folders that aren't a known project (highlighted, but no context map).
  const looseFolders = useMemo(() => {
    const seen = new Set<string>();
    const arr: string[] = [];
    for (const m of mentions) if (!m.workspaceId) { const k = m.text.toLowerCase(); if (!seen.has(k)) { seen.add(k); arr.push(m.text); } }
    return arr;
  }, [mentions]);

  // Pull the spec-driven artifacts for each mentioned project from disk, so the
  // "specs that will be referenced" list is accurate even when they aren't in
  // the always-on context. Refetches only when the mentioned set changes.
  useEffect(() => {
    if (!sessionId || mentionedIds.length === 0) { setSpecDocs({}); return; }
    let live = true;
    Promise.all(
      mentionedIds.map((id) =>
        window.kotrain.readSpecDocs(sessionId, id)
          .then((r) => [id, r.docs.filter((d) => d.exists)] as const)
          .catch(() => [id, [] as SpecDocStatus[]] as const),
      ),
    ).then((entries) => { if (live) setSpecDocs(Object.fromEntries(entries)); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, mentionKey]);

  // For each mentioned project: is it grounding the chat, and what context does it drag in?
  const refsByProject = useMemo(() => {
    const map: Record<string, { folder: WorkspaceFolder; active: boolean; refs: ContextRef[] }> = {};
    for (const id of mentionedIds) {
      const w = workspaces.find((x) => x.id === id);
      if (!w) continue;
      const active = activeWorkspaceIds.includes(id);
      const under = contextItems.filter((it) => isUnder(it.origin, w.path));
      const refs: ContextRef[] = [];
      for (const it of under.filter((x) => x.source === 'guideline')) refs.push({ kind: 'guideline', label: it.label });
      for (const d of specDocs[id] ?? []) refs.push({ kind: 'spec', label: d.label, sub: d.filename });
      for (const it of under.filter((x) => x.source === 'attached-file' && isSpecName(baseName(x.origin)))) {
        if (!refs.some((r) => r.kind === 'spec' && r.label === it.label)) refs.push({ kind: 'spec', label: it.label });
      }
      for (const it of under.filter((x) => x.source === 'attached-file' && !isSpecName(baseName(x.origin)))) refs.push({ kind: 'file', label: it.label });
      const codeCount = under.filter((x) => x.source === 'index-snippet').length;
      if (codeCount > 0) refs.push({ kind: 'code', label: `${codeCount} code snippet${codeCount === 1 ? '' : 's'}` });
      map[id] = { folder: w, active, refs };
    }
    return map;
  }, [mentionedIds, workspaces, activeWorkspaceIds, contextItems, specDocs]);

  // Render collapsed (zero height) rather than unmounted below the threshold,
  // so the bar grows in smoothly instead of shoving the composer mid-keystroke.
  const active = text.trim().length >= 12;

  const present = a.parts.filter((p) => p.present).length;
  const issues = a.findings.length;
  const refCount = mentionedIds.length + looseFolders.length;
  const showAnnotated = a.findings.some((f) => f.start != null) || mentions.length > 0;

  return (
    <div className={`collapse-wrap ${active ? '' : 'collapsed'}`} aria-hidden={!active}>
      <div className="min-h-0 overflow-hidden">
        <div className="mx-auto mb-2 w-full max-w-3xl">
      <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1 text-[11px]" style={{ background: 'var(--surface-2)' }}>
        <GradeBadge grade={a.grade} />
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left text-ink-soft">
          <span>{present}/{a.parts.length} parts</span>
          <span className="text-ink-faint">·</span>
          <span>{issues === 0 ? 'looks good' : `${issues} suggestion${issues === 1 ? '' : 's'}`}</span>
          {refCount > 0 && (
            <>
              <span className="text-ink-faint">·</span>
              <span className="flex items-center gap-1 text-accent" title="Projects and folders this prompt will pull into context">
                <FolderIcon className="h-3 w-3" />{refCount}
              </span>
            </>
          )}
          <span className="ml-auto chip text-[10px] uppercase" title={a.model.reason}>{a.model.tier} model</span>
          <span className="text-ink-faint">{open ? '▾' : '▸'}</span>
        </button>
      </div>

      {open && (
        <div className="mt-1 space-y-2 rounded-lg border border-line p-2.5 text-[12px]" style={{ background: 'var(--surface)' }}>
          {/* What this prompt will reference — mentioned projects + their context. */}
          {refCount > 0 && (
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                <FolderIcon className="h-3 w-3" /> Will reference
              </p>
              {mentionedIds.map((id) => {
                const entry = refsByProject[id];
                if (!entry) return null;
                return (
                  <div key={id} className="rounded-lg border border-line p-2" style={{ background: 'var(--surface-2)' }}>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium"
                        style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                      >
                        <FolderIcon className="h-3 w-3" />{baseName(entry.folder.path) || entry.folder.name}
                      </span>
                      {!entry.active && <span className="chip text-[10px]" title="Mentioned, but not added to this chat yet">not in chat</span>}
                    </div>
                    {entry.active ? (
                      entry.refs.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {entry.refs.map((r, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1 rounded-full border border-line px-1.5 py-0.5 text-[10px] text-ink-soft"
                              title={REF_META[r.kind].label}
                            >
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: REF_META[r.kind].color }} />
                              {r.label}{r.sub ? <span className="text-ink-faint"> · {r.sub}</span> : null}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="mt-1 text-[11px] text-ink-faint">Grounding this chat. No guideline or spec files detected yet.</p>
                      )
                    ) : (
                      <p className="mt-1 text-[11px] text-ink-faint">Add this folder to the chat to ground it in its code, guidelines, and specs.</p>
                    )}
                  </div>
                );
              })}
              {looseFolders.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[11px] text-ink-faint">
                  <span>Folders:</span>
                  {looseFolders.map((f, i) => (
                    <span key={i} className="rounded-sm px-1 py-0.5 font-mono text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>{f}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Present parts read as badges; missing ones are buttons that insert
              a starter snippet matched to what the prompt is about. */}
          <div className="flex flex-wrap gap-1">
            {a.parts.map((p) => {
              if (p.present) {
                return (
                  <span
                    key={p.id}
                    title={p.hint}
                    className="cursor-help rounded-full border px-2 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}
                  >
                    ✓ {p.label}
                  </span>
                );
              }
              const fill = onFill ? suggestPartFill(p.id, text) : null;
              if (!fill) {
                return (
                  <span
                    key={p.id}
                    title={p.hint}
                    className="cursor-help rounded-full border px-2 py-0.5 text-[11px]"
                    style={{ borderColor: 'var(--line)', color: 'var(--ink-faint)' }}
                  >
                    + {p.label}
                  </span>
                );
              }
              return (
                <button
                  key={p.id}
                  title={`${p.hint} Click to insert: "${fill.snippet}"`}
                  className="rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] text-ink-faint transition-colors hover:border-solid hover:border-accent hover:text-accent"
                  onClick={() => onFill?.(fill)}
                >
                  + {p.label}
                </button>
              );
            })}
          </div>

          <p className="text-[11px] text-ink-faint">
            <span className="font-medium text-ink-soft">Suggested model:</span> {a.model.reason}
          </p>

          {a.findings.length > 0 ? (
            <ul className="space-y-1">
              {[...a.findings].sort((x, y) => SEV_ORDER[x.severity] - SEV_ORDER[y.severity]).map((f, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[f.severity] }} />
                  <span className="text-ink-soft">{f.message}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-faint">Clear task and structure, nothing to flag.</p>
          )}

          {showAnnotated && (
            <div className="rounded-lg border border-line p-2 font-mono text-[11px] leading-relaxed" style={{ background: 'var(--surface-2)' }}>
              <Annotated text={text} findings={a.findings} mentions={mentions} />
            </div>
          )}
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

function GradeBadge({ grade }: { grade: 'A' | 'B' | 'C' | 'D' | 'F' }) {
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white"
      style={{ background: GRADE_COLOR[grade] }}
      title={`Prompt health: ${grade}`}
    >
      {grade}
    </span>
  );
}

type Mark =
  | { start: number; end: number; kind: 'mention' }
  | { start: number; end: number; kind: 'finding'; sev: Severity };

/**
 * Render the prompt with mentioned projects/folders highlighted and flagged weak
 * spots wavy-underlined by severity. Mentions win any overlap with a finding.
 */
function Annotated({ text, findings, mentions }: { text: string; findings: Finding[]; mentions: MentionMatch[] }) {
  const marks: Mark[] = [];
  for (const m of mentions) marks.push({ start: m.start, end: m.end, kind: 'mention' });
  for (const f of findings) if (f.start != null && f.end != null) marks.push({ start: f.start, end: f.end, kind: 'finding', sev: f.severity });
  // By position; on a tie, mentions first so they win the overlap-drop below.
  marks.sort((x, y) => x.start - y.start || (x.kind === 'mention' ? -1 : 1));

  const segs: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  let lastEnd = 0;
  for (const mk of marks) {
    if (mk.start < lastEnd) continue; // skip overlaps
    if (mk.start > pos) segs.push(text.slice(pos, mk.start));
    const slice = text.slice(mk.start, mk.end);
    if (mk.kind === 'mention') {
      segs.push(
        <span key={key++} className="rounded-sm px-0.5" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          {slice}
        </span>,
      );
    } else {
      segs.push(
        <span
          key={key++}
          style={{ textDecoration: 'underline', textDecorationStyle: 'wavy', textDecorationColor: SEVERITY_COLOR[mk.sev], textUnderlineOffset: 2 }}
        >
          {slice}
        </span>,
      );
    }
    pos = mk.end;
    lastEnd = mk.end;
  }
  if (pos < text.length) segs.push(text.slice(pos));
  return <span className="whitespace-pre-wrap wrap-break-word text-ink-soft">{segs}</span>;
}
