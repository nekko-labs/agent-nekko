import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, Session, ShellOption, TerminalInfo, WorkspaceFolder } from '@agent-nekko/shared';
import { collectSessionPrUrls, parsePrUrl } from '@agent-nekko/shared';
import { useStore, type WbGroup, type WbPane } from '../store.js';
import { ChatPane } from '../components/ChatPane.js';
import { TerminalPane } from '../components/TerminalPane.js';
import { FilePane } from '../components/FilePane.js';
import { BrowserPane } from '../components/BrowserPane.js';
import { HypergatePane } from '../components/HypergatePane.js';
import { DiffPane } from '../components/DiffPane.js';
import { PrPane, PrBadge } from '../components/PrCard.js';
import { ContextInspector } from '../components/ContextInspector.js';
import { ChatIcon, TerminalIcon, PlusIcon, SplitIcon, CloseIcon, FileIcon, ExternalIcon, PanelIcon, ShieldIcon } from '../icons.js';
import { SHORTCUTS } from '../shortcuts.js';
import { NekkoAvatar } from '../components/Mascot.js';

/** Short label for a pane's tab/title. */
function paneTitle(pane: WbPane, sessions: Session[], terminals: TerminalInfo[]): string {
  if (pane.kind === 'chat') return sessions.find((s) => s.id === pane.refId)?.title ?? 'Chat';
  if (pane.kind === 'terminal') return terminals.find((x) => x.id === pane.refId)?.title || 'Terminal';
  if (pane.kind === 'browser') {
    try { return new URL(pane.refId).host || 'Browser'; } catch { return 'Browser'; }
  }
  if (pane.kind === 'hypergate') return 'Hypergate';
  if (pane.kind === 'diff') return 'Changes';
  if (pane.kind === 'pr') {
    const p = parsePrUrl(pane.refId);
    return p ? `PR #${p.number}` : 'Pull request';
  }
  return pane.refId.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || pane.refId;
}

/** Icon for a pane's tab by kind. */
function PaneIcon({ kind }: { kind: WbPane['kind'] }) {
  const cls = 'h-3.5 w-3.5 shrink-0 text-ink-faint';
  if (kind === 'terminal') return <TerminalIcon className={cls} />;
  if (kind === 'browser') return <ExternalIcon className={cls} />;
  // The one tab that is a product rather than a document, so it keeps the
  // accent its card in Settings uses instead of the muted tab grey.
  if (kind === 'hypergate') return <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-accent" />;
  if (kind === 'pr') return <span className="w-3.5 shrink-0 text-center text-[12px] leading-none text-ink-faint">⑂</span>;
  if (kind === 'file' || kind === 'diff') return <FileIcon className={cls} />;
  return <ChatIcon className={cls} />;
}

/** Render a pane's body by kind. */
function PaneBody({ pane }: { pane: WbPane }) {
  switch (pane.kind) {
    case 'chat': return <ChatPane key={pane.refId} sessionId={pane.refId} />;
    case 'terminal': return <TerminalPane key={pane.refId} terminalId={pane.refId} />;
    case 'file': return <FilePane key={pane.refId} path={pane.refId} />;
    case 'browser': return <BrowserPane key={pane.refId} url={pane.refId} />;
    case 'hypergate': return <HypergatePane key={pane.refId} url={pane.refId} />;
    case 'diff': return <DiffPane key={pane.refId} sessionId={pane.refId} />;
    case 'pr': return <PrPane key={pane.refId} url={pane.refId} />;
    default: return null;
  }
}

/**
 * The workbench: a Warp/Devin-style multi-pane surface. The left sidebar groups
 * work by project (chats, terminals, and nested sub-agents); the center hosts
 * tabbed panes that can be split side by side so many agents and terminals run
 * at once.
 */

/** Live state of an agent, surfaced as a dot on its sidebar row and tab. */
type AgentStatus = 'working' | 'input' | 'error';
const STATUS_META: Record<AgentStatus, { color: string; label: string; pulse: boolean }> = {
  working: { color: 'var(--accent)', label: 'Working…', pulse: true },
  input: { color: 'var(--warning)', label: 'Needs your input', pulse: true },
  error: { color: 'var(--danger)', label: 'Stopped on an error', pulse: false },
};

function StatusDot({ status, className = '' }: { status: AgentStatus; className?: string }) {
  const m = STATUS_META[status];
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${m.pulse ? 'animate-pulse' : ''} ${className}`}
      style={{ background: m.color }}
      title={m.label}
    />
  );
}

/** Something being dragged in the sidebar (a project, chat, or terminal). */
type DragItem = { kind: 'project' | 'chat' | 'terminal'; id: string; ws: string | undefined };

/**
 * Sort by manual drag order when set, else by a fallback (recency for chats,
 * age for terminals). Manually-ordered items sort above never-dragged ones.
 */
function bySidebarOrder<T extends { order?: number }>(fallback: (x: T) => number) {
  return (a: T, b: T) => {
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return fallback(a) - fallback(b);
  };
}

/** Fold an agent event into the per-session status (undefined = idle). */
function statusFromEvent(type: AgentEvent['type']): AgentStatus | null {
  switch (type) {
    case 'tool_approval_required': return 'input';
    case 'error': return 'error';
    case 'done': return null;
    default: return 'working';
  }
}

export function WorkbenchView() {
  const {
    sessions, terminals, groups, activeGroupId, settings, activeSessionId,
    refreshSessions, refreshTerminals, openChatPane, openTerminalPane, newTerminal,
    setActivePane, closePane, focusGroup, splitRight, newChat, setActiveWorkspace,
    reorderWorkspaces, layoutChats, layoutTerminals, contextPanelOpen,
  } = useStore();

  const [statuses, setStatuses] = useState<Map<string, AgentStatus>>(new Map());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [mobileNav, setMobileNav] = useState(false);
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const newMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { refreshTerminals(); }, [refreshTerminals]);
  useEffect(() => { window.nekko.listShells().then(setShells).catch(() => {}); }, []);

  // Close the "+" create menu on an outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Open the active session as a pane if the workbench is empty (e.g. arriving
  // from the Command Center or command palette).
  useEffect(() => {
    if (groups.length === 0 && activeSessionId) openChatPane(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive each session's status (working / needs-input / error / idle) from its
  // agent events for the sidebar + tab dots, and surface freshly spawned
  // sub-agents by refreshing the list when an unknown id appears.
  useEffect(() => {
    const known = new Set(sessions.map((s) => s.id));
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      const next = statusFromEvent(e.type);
      setStatuses((prev) => {
        const m = new Map(prev);
        if (next === null) m.delete(e.sessionId);
        else m.set(e.sessionId, next);
        return m;
      });
      if (!known.has(e.sessionId)) { known.add(e.sessionId); refreshSessions(); }
    });
    return off;
  }, [sessions, refreshSessions]);

  // Populate PR badges for chats that reference a PR in their transcript. Only
  // sessions with a detected PR URL and no cached state get a (host-cached)
  // fetch, bounded so we never shell out to gh for a whole list at once.
  useEffect(() => {
    const loaded = useStore.getState().prsBySession;
    sessions
      .filter((s) => !(s.id in loaded) && collectSessionPrUrls(s.messages).length > 0)
      .slice(0, 8)
      .forEach((s) => { void useStore.getState().refreshSessionPrs(s.id); });
  }, [sessions]);

  const childrenOf = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) if (s.parentSessionId) {
      const arr = m.get(s.parentSessionId) ?? [];
      arr.push(s);
      m.set(s.parentSessionId, arr);
    }
    return m;
  }, [sessions]);

  const toggleCollapse = (id: string) =>
    setCollapsed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const titleFor = (pane: WbPane): string => paneTitle(pane, sessions, terminals);

  // Project buckets: a "General" bucket for project-less chats (kept at the top,
  // hidden when empty), then one bucket per workspace. New chats auto-file under
  // the project they're about; a general chat stays in General.
  const buckets: Array<{ ws?: WorkspaceFolder; key: string; name: string }> = [
    { key: '__none', name: 'General' },
    ...(settings?.workspaces ?? []).map((w) => ({ ws: w, key: w.id, name: w.name })),
  ];
  const topChats = (key: string) =>
    sessions
      .filter((s) => !s.parentSessionId && !s.taskId && !s.trainingRunId && (key === '__none' ? !s.workspaceId : s.workspaceId === key))
      .sort(bySidebarOrder<Session>((s) => -s.updatedAt));
  const bucketTerminals = (key: string) =>
    terminals
      .filter((t) => (key === '__none' ? !t.workspaceId : t.workspaceId === key))
      .sort(bySidebarOrder<TerminalInfo>((t) => t.createdAt));

  // --- Sidebar drag-and-drop (reorder projects; reorder/move chats + terminals) ---
  const startDrag = (e: React.DragEvent, item: DragItem) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.id);
    setDrag(item);
  };
  const endDrag = () => { setDrag(null); setDropTarget(null); };
  const overTarget = (e: React.DragEvent, key: string, accept: (d: DragItem) => boolean) => {
    if (!drag || !accept(drag)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== key) setDropTarget(key);
  };
  type Bucket = { ws?: WorkspaceFolder; key: string; name: string };
  const dropOnBucket = (b: Bucket) => {
    const d = drag;
    if (!d) return endDrag();
    if (d.kind === 'project') {
      const ids = (settings?.workspaces ?? []).map((w) => w.id).filter((id) => id !== d.id);
      if (!b.ws) ids.push(d.id);
      else { const i = ids.indexOf(b.key); ids.splice(i < 0 ? ids.length : i, 0, d.id); }
      reorderWorkspaces(ids);
    } else if (d.kind === 'chat') {
      const ids = topChats(b.key).map((c) => c.id).filter((id) => id !== d.id);
      ids.push(d.id);
      layoutChats(b.ws?.id, ids, d.ws !== b.ws?.id ? d.id : null);
    } else {
      const ids = bucketTerminals(b.key).map((t) => t.id).filter((id) => id !== d.id);
      ids.push(d.id);
      layoutTerminals(b.ws?.id, ids, d.ws !== b.ws?.id ? d.id : null);
    }
    endDrag();
  };
  const dropBeforeRow = (b: Bucket, kind: 'chat' | 'terminal', targetId: string) => {
    const d = drag;
    if (!d || d.kind !== kind || targetId === d.id) return endDrag();
    const list = kind === 'chat' ? topChats(b.key).map((c) => c.id) : bucketTerminals(b.key).map((t) => t.id);
    const ids = list.filter((id) => id !== d.id);
    const i = ids.indexOf(targetId);
    ids.splice(i < 0 ? ids.length : i, 0, d.id);
    const moved = d.ws !== b.ws?.id ? d.id : null;
    if (kind === 'chat') layoutChats(b.ws?.id, ids, moved);
    else layoutTerminals(b.ws?.id, ids, moved);
    endDrag();
  };

  const Sidebar = (
    <div className="flex h-full w-64 flex-col border-r border-line" style={{ background: 'var(--paper)' }}>
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-sm font-semibold">Workbench</span>
        <div className="relative" ref={newMenuRef}>
          <button
            className={`rounded-sm p-1.5 ${contextPanelOpen ? 'bg-surface-2 text-accent' : 'text-ink-faint hover:text-ink'}`}
            title={`${contextPanelOpen ? 'Hide' : 'Show'} the folders, files & context panel (${SHORTCUTS.contextPanel.label})`}
            aria-label={`${contextPanelOpen ? 'Hide' : 'Show'} the folders, files and context panel`}
            aria-pressed={contextPanelOpen}
            onClick={() => useStore.getState().toggleContextPanel()}
          >
            <PanelIcon className="h-3.5 w-3.5" />
          </button>
          <button className="btn btn-ghost px-2 py-1" title="New agent or terminal"
            onClick={() => setNewMenuOpen((o) => !o)}><PlusIcon /></button>
          {newMenuOpen && (
            <div className="card absolute right-0 top-9 z-40 w-60 p-1.5 shadow-lg">
              <button
                className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                onClick={() => { setNewMenuOpen(false); newChat(); }}
              >
                <ChatIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">New agent</span>
                  <span className="block text-[11px] text-ink-faint">Chat that drives an agent</span>
                </span>
                <kbd className="kbd mt-0.5">{SHORTCUTS.newAgent.label}</kbd>
              </button>

              <div className="my-1 border-t border-line" />
              <div className="flex items-center justify-between gap-2 px-2.5 pb-0.5 pt-1">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">Terminal</p>
                <kbd className="kbd">{SHORTCUTS.newTerminal.label}</kbd>
              </div>
              {shells.length === 0 ? (
                <button
                  className="flex w-full items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                  onClick={() => { setNewMenuOpen(false); newTerminal(); }}
                >
                  <TerminalIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                  <span className="text-[13px] font-medium">New terminal</span>
                </button>
              ) : (
                shells.map((sh) => (
                  <button
                    key={sh.id}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                    title={sh.path}
                    onClick={() => { setNewMenuOpen(false); newTerminal(undefined, sh.path); }}
                  >
                    <TerminalIcon className="h-4 w-4 shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{sh.label}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {buckets.map((b) => {
          const chats = topChats(b.key);
          const terms = bucketTerminals(b.key);
          if (b.key === '__none' && chats.length === 0 && terms.length === 0) return null;
          const isCollapsed = collapsed.has(b.key);
          const bucketActive = dropTarget === 'bucket:' + b.key;
          return (
            <div
              key={b.key}
              className={`mb-1 rounded-lg ${bucketActive ? 'bg-accent-soft ring-1 ring-accent/40' : ''}`}
              onDragOver={(e) => overTarget(e, 'bucket:' + b.key, () => true)}
              onDragLeave={() => { if (dropTarget === 'bucket:' + b.key) setDropTarget(null); }}
              onDrop={(e) => { e.preventDefault(); dropOnBucket(b); }}
            >
              <div
                className="group flex items-center gap-1 rounded-lg px-1.5 py-1 hover:bg-surface-2"
                draggable={!!b.ws}
                onDragStart={b.ws ? (e) => startDrag(e, { kind: 'project', id: b.ws!.id, ws: b.ws!.id }) : undefined}
                onDragEnd={endDrag}
                title={b.ws ? 'Drag to reorder project' : undefined}
              >
                <button className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left" onClick={() => toggleCollapse(b.key)}>
                  <svg
                    className={`h-3 w-3 shrink-0 text-ink-faint transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                  ><path d="M9 6l6 6-6 6" /></svg>
                  <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-ink-faint">{b.name}</span>
                  {isCollapsed && chats.length + terms.length > 0 && (
                    <span className="ml-1 shrink-0 rounded-full bg-surface-2 px-1.5 text-[10px] tabular-nums text-ink-faint">
                      {chats.length + terms.length}
                    </span>
                  )}
                </button>
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  <button className="rounded-md p-1 text-ink-faint hover:bg-paper hover:text-ink" title="New chat in project"
                    onClick={() => { if (b.ws) setActiveWorkspace(b.ws.id); newChat(); }}><PlusIcon className="h-3.5 w-3.5" /></button>
                  <button className="rounded-md p-1 text-ink-faint hover:bg-paper hover:text-ink" title="New terminal in project"
                    onClick={() => newTerminal(b.ws?.id)}><TerminalIcon className="h-3.5 w-3.5" /></button>
                </span>
              </div>
              <div className={`collapse-wrap ${isCollapsed ? 'collapsed' : ''}`}>
                <div className="min-h-0 space-y-px overflow-hidden pb-1">
                  {chats.length === 0 && terms.length === 0 && (
                    <p className="px-3.5 py-1 text-[11px] text-ink-faint">No chats yet</p>
                  )}
                  {chats.map((s) => (
                    <div
                      key={s.id}
                      draggable
                      onDragStart={(e) => startDrag(e, { kind: 'chat', id: s.id, ws: b.ws?.id })}
                      onDragEnd={endDrag}
                      onDragOver={(e) => overTarget(e, 'chatrow:' + s.id, (d) => d.kind === 'chat')}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropBeforeRow(b, 'chat', s.id); }}
                      className={dropTarget === 'chatrow:' + s.id ? 'rounded-lg ring-1 ring-accent/60' : ''}
                    >
                      <ChatRow session={s} depth={0} statuses={statuses} childrenOf={childrenOf}
                        activeSessionId={activeSessionId} onOpen={openChatPane} workspaces={settings?.workspaces ?? []} />
                    </div>
                  ))}
                  {terms.map((t) => (
                    <div
                      key={t.id}
                      draggable
                      onDragStart={(e) => startDrag(e, { kind: 'terminal', id: t.id, ws: b.ws?.id })}
                      onDragEnd={endDrag}
                      onDragOver={(e) => overTarget(e, 'termrow:' + t.id, (d) => d.kind === 'terminal')}
                      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropBeforeRow(b, 'terminal', t.id); }}
                      className={dropTarget === 'termrow:' + t.id ? 'rounded-lg ring-1 ring-accent/60' : ''}
                    >
                      <TerminalRow term={t} onOpen={openTerminalPane} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      {mobileNav && <div className="absolute inset-0 z-20 bg-black/40 md:hidden" onClick={() => setMobileNav(false)} />}
      <aside className={`${mobileNav ? 'absolute inset-y-0 left-0 z-30 flex' : 'hidden'} md:relative md:z-auto md:flex`}>{Sidebar}</aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-2 py-1.5 md:hidden">
          <button className="btn btn-ghost px-2 py-1" onClick={() => setMobileNav(true)} aria-label="Open sidebar">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <span className="text-[13px] font-semibold">Workbench</span>
        </div>

        {groups.length === 0 ? (
          <EmptyState onNewChat={newChat} onNewTerminal={() => newTerminal()} />
        ) : (
          <div className="flex min-h-0 flex-1">
            {groups.map((g) => (
              <PaneGroupView
                key={g.id}
                group={g}
                isActive={g.id === activeGroupId}
                canSplit={groups.length < 3}
                statuses={statuses}
                sessions={sessions}
                titleFor={titleFor}
                workspaces={settings?.workspaces ?? []}
                onFocus={() => focusGroup(g.id)}
                onSelect={(pid) => setActivePane(g.id, pid)}
                onClose={(pid) => closePane(g.id, pid)}
                onSplit={(pid) => splitRight(g.id, pid)}
                onNewChat={() => newChat()}
                onNewTerminal={() => newTerminal()}
              />
            ))}
          </div>
        )}
      </main>

      {/* The right panel: folders + file explorer over the context breakdown. It
          belongs to the workbench rather than to a chat pane, so opening a file
          from the explorer doesn't take the explorer away with it. It follows the
          active chat, and says so when there isn't one. */}
      {contextPanelOpen && (
        <aside className="hidden shrink-0 lg:block" style={{ background: 'var(--paper)' }}>
          <ContextInspector sessionId={activeSessionId} />
        </aside>
      )}
    </div>
  );
}

/**
 * Compact project/tag chips for a chat: the extra projects it references
 * (supporting workspaces) and any free-form tags. The primary project is the
 * sidebar bucket the row already sits in, so it isn't repeated here.
 */
function ChatTags({ session, workspaces }: { session: Session; workspaces: WorkspaceFolder[] }) {
  const chips: Array<{ label: string; project: boolean }> = [
    ...(session.supportingWorkspaceIds ?? [])
      .map((id) => workspaces.find((w) => w.id === id)?.name)
      .filter((n): n is string => !!n)
      .map((label) => ({ label, project: true })),
    ...(session.tags ?? []).map((label) => ({ label, project: false })),
  ];
  if (!chips.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chips.slice(0, 2).map((c, i) => (
        <span
          key={i}
          className="max-w-[70px] shrink-0 truncate rounded-sm px-1 py-px text-[10px] leading-normal"
          style={{ background: 'var(--surface-2)', color: 'var(--ink-faint)' }}
          title={c.project ? `Also references ${c.label}` : `Tag: ${c.label}`}
        >
          {c.label}
        </span>
      ))}
      {chips.length > 2 && <span className="shrink-0 text-[10px] text-ink-faint">+{chips.length - 2}</span>}
    </span>
  );
}

function ChatRow({
  session, depth, statuses, childrenOf, activeSessionId, onOpen, workspaces,
}: {
  session: Session; depth: number; statuses: Map<string, AgentStatus>;
  childrenOf: Map<string, Session[]>; activeSessionId: string | null; onOpen: (id: string) => void;
  workspaces: WorkspaceFolder[];
}) {
  const kids = childrenOf.get(session.id) ?? [];
  const status = statuses.get(session.id);
  const prs = useStore((s) => s.prsBySession[session.id]);
  const isActive = session.id === activeSessionId;
  const nested = depth > 0;
  return (
    <>
      <button
        onClick={() => onOpen(session.id)}
        className={`flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-[13px] transition-colors duration-150 ${
          isActive ? 'bg-accent-soft font-medium text-ink' : 'text-ink-soft hover:bg-surface-2'
        }`}
        style={{ paddingLeft: 14 + depth * 16 }}
      >
        {/* Custom hierarchy bullet, filled for top-level chats, a hollow ring for
            nested sub-agents, so nesting reads clearly without per-row icons. */}
        <span
          aria-hidden
          className={`shrink-0 rounded-full transition-colors ${
            nested
              ? `bg-transparent ring-1 ${isActive ? 'ring-accent' : 'ring-ink-faint'}`
              : isActive ? 'bg-accent' : 'bg-ink-faint'
          }`}
          style={{ width: nested ? 5 : 6, height: nested ? 5 : 6, marginLeft: nested ? 1 : 0 }}
        />
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        {prs?.length ? <PrBadge prs={prs} compact /> : null}
        <ChatTags session={session} workspaces={workspaces} />
        {status && <StatusDot status={status} />}
      </button>
      {kids.map((k) => (
        <ChatRow key={k.id} session={k} depth={depth + 1} statuses={statuses} childrenOf={childrenOf} activeSessionId={activeSessionId} onOpen={onOpen} workspaces={workspaces} />
      ))}
    </>
  );
}

function TerminalRow({ term, onOpen }: { term: TerminalInfo; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(term.id)}
      className="flex w-full items-center gap-1.5 rounded-lg py-1.5 pr-2 text-left text-[13px] text-ink-soft transition-colors duration-150 hover:bg-surface-2"
      style={{ paddingLeft: 14 }}
    >
      <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
      <span className="min-w-0 flex-1 truncate">{term.title}</span>
      {!term.running && <span className="shrink-0 text-[10px]" style={{ color: 'var(--danger)' }}>exited</span>}
    </button>
  );
}

function PaneGroupView({
  group, isActive, canSplit, statuses, sessions, titleFor, workspaces,
  onFocus, onSelect, onClose, onSplit, onNewChat, onNewTerminal,
}: {
  group: WbGroup; isActive: boolean; canSplit: boolean; statuses: Map<string, AgentStatus>;
  sessions: Session[]; titleFor: (p: WbPane) => string; workspaces: WorkspaceFolder[];
  onFocus: () => void; onSelect: (paneId: string) => void; onClose: (paneId: string) => void;
  onSplit: (paneId: string) => void; onNewChat: () => void; onNewTerminal: () => void;
}) {
  const active = group.panes.find((p) => p.id === group.activeId) ?? group.panes[0];
  // The project a chat tab belongs to (tabs from different projects sit side by
  // side, so the chip is what tells them apart).
  const projectFor = (p: WbPane): string | null => {
    if (p.kind !== 'chat') return null;
    const wid = sessions.find((s) => s.id === p.refId)?.workspaceId;
    return wid ? workspaces.find((w) => w.id === wid)?.name ?? null : null;
  };
  return (
    <div className="flex min-w-0 flex-1 flex-col border-r border-line" onMouseDown={onFocus}>
      {/* Tab strip: real tabs, reachable and switchable from the keyboard. */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-line px-1.5 py-1" style={{ background: 'var(--surface-2)' }} role="tablist">
        {group.panes.map((p) => {
          const isActiveTab = p.id === active?.id;
          const status = p.kind === 'chat' ? statuses.get(p.refId) : undefined;
          return (
            <div
              key={p.id}
              role="tab"
              aria-selected={isActiveTab}
              tabIndex={0}
              onClick={() => onSelect(p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.id); }
              }}
              className={`group flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] outline-hidden focus-visible:ring-2 focus-visible:ring-(--ring) ${
                isActiveTab ? 'bg-paper font-medium shadow-xs' : 'text-ink-soft hover:bg-paper/50'
              }`}
              style={isActiveTab ? { background: 'var(--paper)' } : undefined}
            >
              <PaneIcon kind={p.kind} />
              <span className="max-w-[140px] truncate">{titleFor(p)}</span>
              {projectFor(p) && (
                <span
                  className="max-w-[90px] shrink-0 truncate rounded-sm px-1 py-px text-[10px] leading-normal text-ink-faint"
                  style={{ background: 'var(--surface-2)' }}
                  title={`Project: ${projectFor(p)}`}
                >
                  {projectFor(p)}
                </span>
              )}
              {status && <StatusDot status={status} />}
              <button
                className="ml-0.5 rounded-sm p-0.5 text-ink-faint opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
                title="Close tab"
                aria-label={`Close ${titleFor(p)}`}
                onClick={(e) => { e.stopPropagation(); onClose(p.id); }}
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title={`New chat (${SHORTCUTS.newAgent.label})`} onClick={onNewChat}><PlusIcon className="h-3.5 w-3.5" /></button>
          <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title={`New terminal (${SHORTCUTS.newTerminal.label})`} onClick={onNewTerminal}><TerminalIcon className="h-3.5 w-3.5" /></button>
          {canSplit && group.panes.length > 1 && active && (
            <button className="rounded-sm p-1 text-ink-faint hover:text-ink" title="Split tab to the right" onClick={() => onSplit(active.id)}><SplitIcon className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </div>
      {/* Active pane */}
      <div className="min-h-0 flex-1">
        {active ? <PaneBody pane={active} /> : null}
      </div>
    </div>
  );
}

function EmptyState({ onNewChat, onNewTerminal }: { onNewChat: () => void; onNewTerminal: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={34} /></div>
      <div>
        <h2 className="text-lg font-semibold">Your workbench is empty</h2>
        <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-faint">Open a chat to drive an agent, or a terminal to run commands. Open several and split them side by side.</p>
      </div>
      <div className="flex gap-2">
        <button className="btn btn-primary" onClick={onNewChat}>
          <ChatIcon className="h-4 w-4" /> New chat <kbd className="kbd">{SHORTCUTS.newAgent.label}</kbd>
        </button>
        <button className="btn btn-outline" onClick={onNewTerminal}>
          <TerminalIcon className="h-4 w-4" /> New terminal <kbd className="kbd">{SHORTCUTS.newTerminal.label}</kbd>
        </button>
      </div>
    </div>
  );
}
