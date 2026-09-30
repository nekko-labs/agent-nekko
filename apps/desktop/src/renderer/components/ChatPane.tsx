import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent, AskAnswer, AskRequest, AutoQuality, ChatMessage, Session, ToolCall, ContextBundle, IndexedFile, ModelInfo, ProviderConfig, SkillDef, PrInfo, PromptPlan } from '@agent-nekko/shared';
import { pickAutoModel, AUTO_MODEL_ID, matchSkills, estimateTokens, estimateTranscriptTokens, modelSupportsThinking, getSessionWorkspaceIds, extractPrUrls, collectSessionPrUrls, detectSessionWorkspace, decodeRate, hasResumableProgress, isLocalProvider, resolveModelAvailability, planAsPromptBlock, estimateCostUSD, shortLiveStatus } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { useGitStatus } from '../useGitStatus.js';
import { clearLiveRun, getLiveRun, useLiveRun } from '../liveRuns.js';
import { useProviderLimits } from '../useLimits.js';
import { clearDraft, loadDraft, saveDraft } from '../composerDrafts.js';
import { Markdown } from './Markdown.js';
import {
  ActivityGroup, ApprovalBar, AutoQualityMenu, MessageBubble, ModelPicker,
  ReplyStatus, toStreamBlocks, useElementWidth,
} from './agent-console/index.js';
import type { Activity, PendingApproval } from './agent-console/index.js';
import { ContextGauge, EffortMenu } from './ChatMetrics.js';
import { PlanRail } from './PlanRail.js';
import { QuestionCard } from './QuestionCard.js';
import { UsageLimitsChip } from './UsageLimitsChip.js';
import { PaneActions, useInPaneFrame } from './PaneFrame.js';
import { ContextWarning } from './ContextWarning.js';
import { ChatControls } from './ChatControls.js';
import { PromptAnalyzer } from './PromptAnalyzer.js';
import { ScheduleTaskModal } from './ScheduleTaskModal.js';
import { PrCard, PrBadge } from './PrCard.js';
import { NekkoAvatar } from './Mascot.js';
import { Modal } from './primitives/index.js';
import { PanelIcon, DownloadIcon, PlusIcon, CloseIcon, BoltIcon, ThoughtIcon, ListIcon, BranchIcon, WorktreeIcon } from '../icons.js';

const NO_PRS: PrInfo[] = []; // stable empty ref so the store selector doesn't churn

/**
 * How often streamed deltas are committed to React state. Tokens arrive one
 * event at a time; setting state per token re-renders the whole transcript per
 * token, which stutters on a long reply and locks the window on a very fast or
 * runaway one. Batching to ~20fps is imperceptible while streaming and turns
 * thousands of renders into a few dozen.
 */
const STREAM_FLUSH_MS = 50;

/**
 * How often a running turn re-reads its context bundle. Each completed step is
 * checkpointed to disk, so a preview between steps is accurate; the throttle
 * keeps a tool-heavy turn from asking on every single result.
 */
const CTX_REFRESH_MS = 1_500;

/**
 * Pane widths the layout keys off, measured on the pane itself.
 *
 * `PLAN_RAIL_MIN_PANE` is the point below which showing the rail would cost the
 * conversation more than the rail is worth; `NARROW_PANE` is where the 75%
 * column stops helping and the text should just use the pane.
 */
const PLAN_RAIL_MIN_PANE = 900;
const NARROW_PANE = 620;

/**
 * The composer's height when the user has dragged it, remembered across chats.
 * Unset means "grow with what's typed", which is where every composer starts.
 */
const COMPOSER_H_KEY = 'nekko.composer.height';
const COMPOSER_MIN_H = 52;
/** The conversation keeps at least this much of the pane, however tall the composer. */
const TRANSCRIPT_MIN_H = 160;

function readComposerHeight(): number | null {
  try {
    const n = Number(window.localStorage.getItem(COMPOSER_H_KEY));
    return Number.isFinite(n) && n >= COMPOSER_MIN_H ? n : null;
  } catch {
    return null;
  }
}

/**
 * Cap on a live buffer's length. The engine cuts a looping model off (see
 * runaway.ts), so this is the second line of defence: it keeps the renderer
 * from ever holding an unbounded string. The tail is kept because that's the
 * part still being written.
 */
const LIVE_STREAM_MAX = 40_000;

function clampLive(s: string): string {
  return s.length <= LIVE_STREAM_MAX ? s : `…\n${s.slice(-LIVE_STREAM_MAX)}`;
}

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Turn a chat image into a Blob. Chat images are data URLs, and the renderer's
 * CSP has no `data:` in connect-src, so `fetch()` on one fails ("Failed to
 * fetch") — decode it by hand instead, and keep fetch only for real URLs.
 */
async function imageBlob(src: string): Promise<Blob> {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(src);
  if (!match) return fetch(src).then((r) => r.blob());
  const type = match[1] || 'image/png';
  if (!match[2]) return new Blob([decodeURIComponent(match[3])], { type });
  const binary = atob(match[3]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/** Re-encode an image as PNG, the only format Chromium will put on the
 *  clipboard. Draws straight from the source URL, which already renders in the
 *  page, so no extra object URL is needed. */
function toPngBlob(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('Could not encode the image.'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Could not read the image.'));
    img.src = src;
  });
}

/** Put a chat image on the system clipboard (as PNG, whatever it arrived as). */
async function copyImageToClipboard(src: string): Promise<void> {
  const blob = await imageBlob(src);
  const png = blob.type === 'image/png' ? blob : await toPngBlob(src);
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** Save a chat image to disk, keeping its original format. Goes through a blob
 *  URL rather than the data URL, which Chromium won't always download. */
async function downloadImage(src: string): Promise<void> {
  const blob = await imageBlob(src);
  const ext = (/^image\/([a-z0-9.+-]+)/i.exec(blob.type)?.[1] ?? 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `agent-nekko-image.${ext === 'jpeg' ? 'jpg' : ext || 'png'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Right-click menu for a chat image: copy it to the clipboard, or save it. A
 * webview's native menu isn't available here, so this is the app's own, placed
 * at the pointer and flipped when it would run off the edge.
 */
function ImageMenu({ x, y, src, onClose }: { x: number; y: number; src: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Close on a press *outside* the menu, tested against the element rather
    // than by stopping propagation: this menu is portalled to `body`, so a press
    // inside it reaches the document listener anyway, and closing on mousedown
    // would unmount the item before its click could fire.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape dismisses the top layer only. Captured on `window`, one step
      // ahead of the lightbox's own document-capture handler, so stopping
      // propagation here actually keeps the lightbox open.
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const WIDTH = 176;
  const HEIGHT = 76;
  const left = Math.min(x, Math.max(8, window.innerWidth - WIDTH - 8));
  const top = Math.min(y, Math.max(8, window.innerHeight - HEIGHT - 8));

  const copy = async () => {
    onClose();
    try {
      await copyImageToClipboard(src);
      useStore.getState().pushToast('success', 'Image copied to the clipboard.');
    } catch {
      useStore.getState().pushToast('error', "Couldn't copy that image.");
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="card fixed w-44 p-1.5 shadow-lg"
      style={{ left, top, zIndex: 60 }}
      role="menu"
      aria-label="Image actions"
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        role="menuitem"
        className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
        onClick={copy}
      >
        Copy image
      </button>
      <button
        role="menuitem"
        className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
        onClick={async () => {
          onClose();
          try {
            await downloadImage(src);
          } catch {
            useStore.getState().pushToast('error', "Couldn't save that image.");
          }
        }}
      >
        Save image…
      </button>
    </div>,
    document.body,
  );
}

/**
 * One chat conversation, fully self-contained so several can run side by side in
 * the workbench. Provider/model are chosen per-pane (independent agents); the
 * pane subscribes to agent events filtered by its own sessionId.
 */
/**
 * The chat's own chrome, wherever it happens to be.
 *
 * Inside a workspace window the frame already draws a title strip with this
 * chat's name in it, so the actions move into that strip and no second bar is
 * drawn: two bars stacked on each other, both saying the same title, was the
 * shape this replaces. Anywhere else there is no strip to join, so the chat
 * draws the header it always did.
 */
function ChatHeader({
  title,
  subAgent,
  children,
}: {
  title: string;
  subAgent: boolean;
  children: React.ReactNode;
}) {
  const framed = useInPaneFrame();
  if (framed) {
    return (
      <PaneActions>
        {subAgent && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
        {children}
      </PaneActions>
    );
  }
  return (
    <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-[13px] font-medium">{title}</span>
        {subAgent && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </header>
  );
}

export function ChatPane({ sessionId, onRunningChange }: { sessionId: string; onRunningChange?: (running: boolean) => void }) {
  const { providers, settings, setMascotMood, refreshSessions } = useStore();

  const [session, setSession] = useState<Session | null>(null);
  // Seed the composer from whatever was parked for this chat, so an unsent
  // message survives a tab switch or a restart.
  const [draft, setDraft] = useState(() => loadDraft(sessionId)?.text ?? '');
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveReasoning, setLiveReasoning] = useState('');
  const [liveTools, setLiveTools] = useState<ToolCall[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  /**
   * The question the agent stopped to ask, when it has. Seeded from the host on
   * mount as well as from the event, so a question asked while this pane was
   * closed is still there when it opens.
   */
  const [question, setQuestion] = useState<AskRequest | null>(null);
  const [ctx, setCtx] = useState<ContextBundle | null>(null);
  // Tokens this turn has produced that the last context bundle doesn't include
  // yet. Everything the agent writes (its reply, its tool calls, their results)
  // is replayed in the next request's prompt, so the window fills as the turn
  // runs; without this the gauge sat still for minutes and jumped at the end.
  const [liveCtxTokens, setLiveCtxTokens] = useState(0);
  const liveCtxRef = useRef(0);
  const lastCtxRefresh = useRef(0);
  const [tps, setTps] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [atFiles, setAtFiles] = useState<IndexedFile[]>([]);
  const [cost, setCost] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  // The + menu's Skill row expands its skills as a side flyout on hover (no
  // click needed); a short close-delay lets the pointer cross the seam.
  const [skillsHover, setSkillsHover] = useState(false);
  const skillsFlyTimer = useRef<number | null>(null);
  const [pendingImages, setPendingImages] = useState<string[]>(() => loadDraft(sessionId)?.images ?? []);
  // The context panel toggle lives in the store so the ⌘\ shortcut and the
  // command palette's "Toggle context panel" act on this pane too.
  const ctxOpen = useStore((s) => s.contextPanelOpen);
  // The plan/sub-agent rail beside the transcript (see PlanRail). Whether there
  // is room for it depends on this pane, not on the window: the workbench splits,
  // so a viewport breakpoint would keep the rail open in a pane squeezed to a
  // third of a wide screen and drop it from a narrow window that has nothing
  // else on it.
  const planRailWanted = useStore((s) => s.planRailOpen);
  const paneRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(paneRef);
  const planRailOpen = planRailWanted && paneWidth >= PLAN_RAIL_MIN_PANE;
  const wideEnoughForRail = paneWidth >= PLAN_RAIL_MIN_PANE;
  // The armed skill lives in the store (per session) so the Context Inspector on
  // the right can show it and count its tokens while it's active.
  const activeSkill = useStore((s) => s.activeSkillBySession[sessionId] ?? null);
  const setActiveSkill = (skill: SkillDef | null) => useStore.getState().setActiveSkill(sessionId, skill);
  // PRs referenced in this chat (for the header badge + inline cards).
  const prs = useStore((s) => s.prsBySession[sessionId] ?? NO_PRS);
  // Where this chat is working in git: the worktree, the branch, and the PR
  // that branch is going into. The same read the sidebar card makes (the host
  // caches it), so the header and the card never disagree.
  const git = useGitStatus(session ? getSessionWorkspaceIds(session)[0] : undefined);
  const headerPrs = git?.pr && !prs.some((p) => p.url === git.pr!.url) ? [git.pr, ...prs] : prs;
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Right-click menu for a chat image (copy / save), placed at the pointer.
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  const [reasoningDuration, setReasoningDuration] = useState<number | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [doneSummary, setDoneSummary] = useState<string | null>(null);
  // What the model thinks the user will say next: one-click follow-up chips and
  // the composer's ghost text. Pinned to the reply it was written for (forId) so
  // a newer turn can't inherit stale suggestions.
  const [suggestions, setSuggestions] = useState<{ forId: string; options: string[]; next: string | null } | null>(null);
  // A failed reply stays in the transcript with a retry, instead of vanishing
  // with the toast.
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  // Whether this pane's model list has come back yet, so the "pick a model"
  // nudge waits for the truth instead of flashing during the fetch.
  const [modelsLoaded, setModelsLoaded] = useState(false);
  // The model menu's open state lives here so the nudge below the transcript can
  // open the very picker it points at.
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // The "choose a model" tooltip is a one-shot nudge: opening the picker means
  // the point landed, so it retires for this chat instead of hanging around.
  const [modelHintDone, setModelHintDone] = useState(false);
  // Live telemetry for the subtext under the chat: output tokens, elapsed
  // seconds, and a summary of the last completed reply.
  const [turnOut, setTurnOut] = useState(0);
  /**
   * What the reply now running has cost so far, at published list prices,
   * accumulated per step as the usage events arrive rather than read back from
   * the usage log after the turn ends. A long agentic turn is exactly when
   * someone wants to see the number moving.
   */
  const [turnCost, setTurnCost] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [lastTurn, setLastTurn] = useState<{ out: number; tps: number; secs: number } | null>(null);
  // Keyboard state for the slash/@ menus: the highlighted row, and whether the
  // user dismissed the menu with Escape (typing re-opens it).
  const [menuSel, setMenuSel] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  // "Jump to latest" pill: shown when new content streams in while the reader
  // has scrolled up.
  const [showJump, setShowJump] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // A dragged composer height, or null to size to the draft. See COMPOSER_H_KEY.
  const [composerH, setComposerH] = useState<number | null>(readComposerHeight);
  const composerSectionRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const turnStart = useRef(0);
  // Milliseconds the model actually spent generating this turn's tokens, summed
  // over the reply's steps. Separate from `turnStart`, which is wall clock and
  // also covers prompt processing, tool runs, and approval waits, so dividing
  // tokens by it under-reports throughput (badly, on a tool-heavy turn).
  const turnDecodeMsRef = useRef(0);
  const reasoningStart = useRef(0);
  const turnOutRef = useRef(0);
  /**
   * Cost the provider has actually reported for this turn, summed per step.
   *
   * Kept apart from the estimate below because the two have different standing:
   * this is measured, that is a guess made while we wait for the measurement.
   */
  const turnCostRef = useRef(0);
  /**
   * Tokens streamed since the last usage report, and the prompt tokens of a
   * step that has not reported yet.
   *
   * Without these the figure only moved once, at the end: an OpenAI-compatible
   * server sends its usage chunk after the last content chunk, so there is
   * nothing measured to show during the reply people actually want to watch.
   * These price what has arrived so far and are dropped the moment the real
   * numbers land, so the estimate converges on the truth rather than adding to it.
   */
  const pendingOutRef = useRef(0);
  const pendingInRef = useRef(0);
  /**
   * The model this turn is actually running on, for pricing its usage events.
   * A ref because the agent-event listener is long-lived, and the model can be
   * resolved per send (Auto mode), so the state variable would price a turn at
   * whatever the picker shows now rather than at what ran.
   */
  const modelForCostRef = useRef<string | null>(null);
  // Ref mirrors of the live buffers: the agent-event listener closure is
  // long-lived, so reading the state variables there would see stale values.
  const liveToolsRef = useRef<ToolCall[]>([]);
  const liveTextRef = useRef('');
  // Streamed deltas land here and are committed together on a timer (see
  // STREAM_FLUSH_MS), so the transcript renders per frame rather than per token.
  const pendingText = useRef('');
  const pendingReasoning = useRef('');
  const flushTimer = useRef<number | null>(null);
  // Whether the reader is at (or near) the bottom of the transcript. Streaming
  // only auto-follows while this is true, so scrolling up to read is possible.
  const pinnedRef = useRef(true);
  const didFirstScroll = useRef(false);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) closeAttachMenu();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Track how many files the agent changed this chat (for the Changes button).
  useEffect(() => {
    let live = true;
    const load = () => window.nekko.listChanges(sessionId).then((c) => { if (live) setChangeCount(c.length); }).catch(() => {});
    load();
    const off = window.nekko.onChangesUpdated((e) => { if (e.sessionId === sessionId) load(); });
    return () => { live = false; off(); };
  }, [sessionId]);

  useEffect(() => onRunningChange?.(streaming), [streaming, onRunningChange]);

  /**
   * Pull a fresh context bundle and settle the live estimate against it.
   *
   * The agent loop appends each assistant message and tool result to the
   * session as it goes, so a mid-turn preview is real, not stale. Whatever has
   * streamed since the request went out stays in `liveCtxRef` (the bundle can't
   * know about it yet), which is why the mark is subtracted rather than reset:
   * tokens that arrived during the round trip would otherwise be dropped.
   */
  const refreshCtx = () => {
    const mark = liveCtxRef.current;
    lastCtxRefresh.current = Date.now();
    window.nekko.previewContext(sessionId, [])
      .then((b) => {
        setCtx(b);
        liveCtxRef.current = Math.max(0, liveCtxRef.current - mark);
        setLiveCtxTokens(liveCtxRef.current);
      })
      .catch(() => setCtx(null));
  };

  /** Refresh at most every CTX_REFRESH_MS, for the per-step mid-turn updates. */
  const refreshCtxThrottled = () => {
    if (Date.now() - lastCtxRefresh.current < CTX_REFRESH_MS) return;
    refreshCtx();
  };

  // Load the session; seed provider/model from it (or the global defaults).
  useEffect(() => {
    window.nekko.getSession(sessionId).then((s) => {
      setSession(s);
      const st = useStore.getState();
      setProviderId(s?.providerId ?? st.activeProviderId ?? providers[0]?.id ?? null);
      setModelId(s?.autoModel ? AUTO_MODEL_ID : (s?.modelId ?? st.activeModelId ?? null));
    });
    refreshCtx();
    useStore.getState().refreshSessionPrs(sessionId);
    setModelHintDone(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Models for this pane's provider (independent of other panes). A chat that
  // has never had a model picked is left unset on purpose: the nudge below the
  // transcript asks for a choice rather than guessing one.
  useEffect(() => {
    if (!providerId) { setModels([]); setModelsLoaded(false); return; }
    setModelsLoaded(false);
    window.nekko.listModels(providerId).then((m) => {
      setModels(m);
      setModelId((cur) => (cur === AUTO_MODEL_ID || (cur && m.some((x) => x.id === cur)) ? cur : null));
      setModelsLoaded(true);
    }).catch(() => { setModels([]); setModelsLoaded(true); });
  }, [providerId]);

  // Per-chat estimated cost. usageSummary already zeroes subscription providers.
  useEffect(() => {
    window.nekko.getUsageSummary().then((u) => {
      const s = u.bySession[sessionId];
      setCost(s ? (s.cost ?? 0) : 0);
    }).catch(() => setCost(0));
  }, [sessionId, session?.modelId, session?.messages.length]);

  /**
   * What this turn has cost so far: measured where the provider has told us,
   * estimated where it has not yet.
   */
  const publishTurnCost = () => {
    const estimate = estimateCostUSD(
      modelForCostRef.current ?? undefined,
      pendingInRef.current,
      pendingOutRef.current,
    );
    setTurnCost(turnCostRef.current + estimate);
  };

  // Commit whatever has streamed in since the last flush.
  const flushStream = () => {
    if (flushTimer.current != null) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const text = pendingText.current;
    const reasoning = pendingReasoning.current;
    pendingText.current = '';
    pendingReasoning.current = '';
    if (text) setLiveText((t) => clampLive(t + text));
    if (reasoning) setLiveReasoning((t) => clampLive(t + reasoning));
    // The same batch that paints the transcript moves the context gauge, so the
    // estimate costs one extra number per frame rather than one per token.
    if (text || reasoning) {
      const produced = text ? estimateTokens(text) : 0;
      liveCtxRef.current += produced;
      setLiveCtxTokens(liveCtxRef.current);
      pendingOutRef.current += estimateTokens(text) + estimateTokens(reasoning);
      publishTurnCost();
    }
  };

  const scheduleFlush = () => {
    if (flushTimer.current == null) {
      flushTimer.current = window.setTimeout(flushStream, STREAM_FLUSH_MS);
    }
  };

  // Never leave a pending flush behind on unmount or a session switch.
  useEffect(() => () => {
    if (flushTimer.current != null) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    pendingText.current = '';
    pendingReasoning.current = '';
  }, [sessionId]);

  // Keep the sidebar's per-workspace context readout fresh while a turn runs.
  // The pane already re-reads its context bundle per step (throttled to
  // CTX_REFRESH_MS); this adds a slow heartbeat so the number also creeps up
  // between steps, and so it settles once at the end of the turn.
  const liveCtxTokensRef = useRef(0);
  liveCtxTokensRef.current = liveCtxTokens;
  const latestCtxRef = useRef(ctx);
  latestCtxRef.current = ctx;
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => {
      const conversationTokens = latestCtxRef.current?.items.find((i) => i.included && i.source === 'conversation')?.tokens
        ?? estimateTranscriptTokens(latestSessionRef.current?.messages ?? []);
      useStore.getState().setSessionCtxEstimate(sessionId, conversationTokens + liveCtxTokensRef.current);
    }, 4_000);
    return () => {
      clearInterval(t);
      useStore.getState().setSessionCtxEstimate(sessionId, null);
    };
  }, [streaming, sessionId]);

  /**
   * Adopt a turn that was already running when this pane mounted.
   *
   * Workspaces render only the active one, so switching tabs unmounts the
   * pane, and a chat that is mid-reply comes back to a fresh, empty one. The
   * run itself never stopped (liveRuns folds it for the whole app), so the
   * text, the tool calls and the clock are read back here rather than waiting
   * for the next token to repaint a pane that looked idle until it arrived.
   */
  useEffect(() => {
    const run = getLiveRun(sessionId);
    if (!run) return;
    liveTextRef.current = run.text;
    setLiveText(clampLive(run.text));
    setLiveReasoning(clampLive(run.reasoning));
    liveToolsRef.current = run.tools;
    setLiveTools(run.tools);
    liveCtxRef.current = 0;
    turnStart.current = run.startedAt;
    turnOutRef.current = run.outputTokens;
    turnDecodeMsRef.current = run.decodeMs;
    setTurnOut(run.outputTokens);
    setTps(decodeRate(run.outputTokens, run.decodeMs));
    if (run.reasoningMs) setReasoningDuration(Math.round(run.reasoningMs / 1000));
    if (run.reasoningStartedAt) { reasoningStart.current = run.reasoningStartedAt; setThinking(true); }
    setStreaming(true);
    setMascotMood('thinking');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Anything this chat is already blocked on. The events below only reach a
  // mounted pane, so a question asked while you were on the board — or before
  // this pane was opened at all — would otherwise be invisible here.
  useEffect(() => {
    let live = true;
    window.nekko.pendingInput().then((pending) => {
      if (!live) return;
      const mine = pending[sessionId];
      if (mine?.question) setQuestion(mine.question);
      if (mine?.approval) setApproval({ call: mine.approval.call, reason: mine.approval.reason, severity: mine.approval.severity });
    }).catch(() => {});
    return () => { live = false; };
  }, [sessionId]);

  // Stream agent events for this session only.
  useEffect(() => {
    const off = window.nekko.onAgentEvent((e: AgentEvent) => {
      if (e.sessionId !== sessionId) return;
      // A reply may start host-side (a queued follow-up, or a task-driven run):
      // reflect it as streaming even though this pane didn't call send().
      if (e.type === 'text' || e.type === 'reasoning' || e.type === 'tool_call') {
        setStreaming(true);
        if (!turnStart.current) { turnStart.current = Date.now(); setMascotMood('thinking'); }
      }
      switch (e.type) {
        case 'text':
          if (reasoningStart.current) {
            setReasoningDuration(Math.round((Date.now() - reasoningStart.current) / 1000));
            reasoningStart.current = 0;
          }
          liveTextRef.current += e.delta;
          pendingText.current += e.delta;
          scheduleFlush();
          break;
        case 'reasoning':
          if (!reasoningStart.current) reasoningStart.current = Date.now();
          pendingReasoning.current += e.delta;
          scheduleFlush();
          setThinking(true);
          break;
        case 'usage': {
          // Accumulate output tokens and decode time across the reply's steps, so
          // the rate is tokens over the time spent generating them: the same
          // figure the runtime reports, rather than tokens over the whole wait.
          turnOutRef.current += e.outputTokens;
          turnDecodeMsRef.current += e.outputMs ?? 0;
          setTurnOut(turnOutRef.current);
          setTps(decodeRate(turnOutRef.current, turnDecodeMsRef.current));
          // Each step is priced as it lands, because the input tokens of a
          // multi-step turn are not one prompt counted once: every step resends
          // the transcript, and that is most of what a long turn costs.
          // Measured numbers for the step that just finished, so the estimate
          // that stood in for it is dropped rather than added to.
          turnCostRef.current += estimateCostUSD(modelForCostRef.current ?? undefined, e.inputTokens, e.outputTokens);
          pendingOutRef.current = 0;
          pendingInRef.current = 0;
          publishTurnCost();
          break;
        }
        case 'tool_call':
          if (reasoningStart.current) {
            setReasoningDuration(Math.round((Date.now() - reasoningStart.current) / 1000));
            reasoningStart.current = 0;
          }
          liveToolsRef.current = [...liveToolsRef.current, e.call];
          setLiveTools((tc) => [...tc, e.call]);
          liveCtxRef.current += estimateTokens(e.call.name) + estimateTokens(JSON.stringify(e.call.input ?? {}));
          setLiveCtxTokens(liveCtxRef.current);
          break;
        case 'tool_approval_required':
          setApproval({ call: e.call, reason: e.reason, severity: e.severity });
          setMascotMood('thinking');
          break;
        case 'question':
          setQuestion(e.request);
          setMascotMood('thinking');
          break;
        case 'question_resolved':
          setQuestion((q) => (q?.callId === e.callId ? null : q));
          break;
        case 'tool_result':
          setApproval(null);
          // The step just landed on disk, so the bundle can account for it (and
          // for the tool's output, which the renderer never sees in full).
          refreshCtxThrottled();
          break;
        case 'error':
          useStore.getState().pushToast('error', e.message || 'Something went wrong.');
          setErrorNotice(e.message || 'Something went wrong.');
          endTurn();
          break;
        case 'done':
          if (reasoningStart.current) {
            setReasoningDuration(Math.round((Date.now() - reasoningStart.current) / 1000));
            reasoningStart.current = 0;
          }
          endTurn();
          refreshCtx();
          void requestSuggestions();
          break;
        case 'session_meta':
          // The session record changed mid-turn — a new agent plan, or a fresh
          // title — so re-read it and refresh the sidebar/boards alongside.
          window.nekko.getSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
          void refreshSessions();
          break;
        case 'session_meta':
          // The session record changed mid-turn — a new agent plan, or a fresh
          // title — so re-read it and refresh the sidebar/boards alongside.
          window.nekko.getSession(sessionId).then((s) => { if (s) setSession(s); }).catch(() => {});
          void refreshSessions();
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, setMascotMood]);

  const endTurn = () => {
    setStreaming(false);
    // The turn is over, so the app-wide live copy goes too: from here the
    // persisted transcript is the record, and leaving the run in place would
    // show the same reply twice to any pane that mounted afterwards.
    clearLiveRun(sessionId);
    // Drop anything still buffered: the persisted message replaces it below, and
    // a flush landing after the clear would resurrect the reply as a duplicate.
    if (flushTimer.current != null) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    pendingText.current = '';
    pendingReasoning.current = '';

    // Snapshot the reply's telemetry for the idle subtext (refs only, so this is
    // safe inside the long-lived agent-event listener closure).
    const secs = turnStart.current ? Math.round((Date.now() - turnStart.current) / 1000) : 0;
    if (turnOutRef.current > 0) {
      setLastTurn({ out: turnOutRef.current, tps: decodeRate(turnOutRef.current, turnDecodeMsRef.current), secs });
    }
    turnOutRef.current = 0;
    turnDecodeMsRef.current = 0;

    // Build a short completion summary from the tools used in this reply (refs, not
    // state — see the ref mirrors above).
    const usedTools = liveToolsRef.current;
    if (usedTools.length > 0) {
      const unique = Array.from(new Set(usedTools.map((t) => t.name)));
      const hasEdit = unique.some((n) => n === 'edit_file' || n === 'write_file');
      const hasRead = unique.some((n) => n === 'read_file' || n === 'list_dir' || n === 'grep' || n === 'glob');
      const hasBash = unique.includes('bash');
      let summary = '';
      if (hasEdit) summary = 'Done updating those files.';
      else if (hasRead) summary = 'Done looking into that.';
      else if (hasBash) summary = 'Done running those commands.';
      else if (liveTextRef.current.trim()) summary = 'Done.';
      if (summary) {
        setDoneSummary(summary);
        setTimeout(() => setDoneSummary(null), 4000);
      }
    }

    setMascotMood('idle');
    turnStart.current = 0;
    reasoningStart.current = 0;
    liveToolsRef.current = [];
    liveTextRef.current = '';

    // Hold the streamed reply on screen until its persisted copy is in state,
    // then clear the live buffers in the same commit, so the end of a reply
    // never flashes the answer out and back in.
    window.nekko.getSession(sessionId).then((s) => {
      setSession(s);
      setLiveText('');
      setLiveReasoning('');
      setLiveTools([]);
    });
    refreshSessions();
    // A reply may have created or updated a PR (e.g. `gh pr create`).
    useStore.getState().refreshSessionPrs(sessionId);
  };

  /**
   * Ask the model what the user might say next, then pin the answer to the
   * reply it was written for. Nice-to-have traffic: a provider hiccup, a
   * session with nothing to suggest from, or a malformed reply all just mean
   * no chips this turn.
   */
  const requestSuggestions = async () => {
    try {
      const res = await window.nekko.suggestReplies(sessionId);
      if (!res || (res.options.length === 0 && !res.next)) return;
      const fresh = await window.nekko.getSession(sessionId);
      const last = fresh?.messages[fresh.messages.length - 1];
      // A turn that started while the call was in flight (a queued prompt, a
      // send from another pane) makes the suggestions stale; drop them.
      if (!last || last.role !== 'assistant') return;
      setSuggestions({ forId: last.id, options: res.options, next: res.next });
    } catch {
      /* suggestions are nice-to-have */
    }
  };

  // Follow the stream only while the reader is pinned to the bottom; otherwise
  // offer the jump pill instead of yanking them down on every token.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinnedRef.current = pinned;
    if (pinned) setShowJump(false);
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      // Instant during streaming: a smooth scroll restarted on every token
      // rubber-bands. Smooth only for discrete additions (a sent message).
      const behavior: ScrollBehavior = streaming || !didFirstScroll.current ? 'auto' : 'smooth';
      el.scrollTo({ top: el.scrollHeight, behavior });
      didFirstScroll.current = true;
    } else {
      setShowJump(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.messages.length, liveText, liveTools.length]);

  const jumpToLatest = () => {
    pinnedRef.current = true;
    setShowJump(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  // Grow the composer with its content: reset to the 3-line minimum, then match
  // the scroll height (CSS max-height caps it and lets it scroll past that).
  // A composer the user has sized keeps that size and scrolls instead.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    if (composerH != null) {
      el.style.height = `${composerH}px`;
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, composerH]);

  /**
   * Drag the line between the conversation and the composer to trade one for
   * the other: up gives the message box more room for a long prompt, down gives
   * it back to the transcript. Everything else in the composer (the controls,
   * the attach row) keeps its size, so only the text box grows, and the
   * transcript is never squeezed below TRANSCRIPT_MIN_H. Double-click the line
   * to go back to growing with the draft.
   */
  const startComposerResize = (e: React.PointerEvent) => {
    const ta = composerRef.current;
    const pane = paneRef.current;
    const section = composerSectionRef.current;
    if (!ta || !pane || !section) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = ta.getBoundingClientRect().height;
    // Whatever in the composer is not the text box, which the drag cannot shrink.
    const chrome = section.getBoundingClientRect().height - startH;
    const maxH = Math.max(COMPOSER_MIN_H, pane.getBoundingClientRect().height - chrome - TRANSCRIPT_MIN_H);
    let latest = startH;
    const onMove = (ev: PointerEvent) => {
      latest = Math.round(Math.min(maxH, Math.max(COMPOSER_MIN_H, startH + (startY - ev.clientY))));
      setComposerH(latest);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      try { window.localStorage.setItem(COMPOSER_H_KEY, String(latest)); } catch { /* private mode */ }
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const resetComposerHeight = () => {
    setComposerH(null);
    try { window.localStorage.removeItem(COMPOSER_H_KEY); } catch { /* private mode */ }
  };

  // --- Draft persistence ---
  // The workbench only mounts the pane you're looking at, so a tab switch (or
  // quitting) tears this composer down. Park what's unsent and restore it.
  const latestDraft = useRef({ text: draft, images: pendingImages });
  latestDraft.current = { text: draft, images: pendingImages };

  // The pane is keyed by session today, so this only matters if the component is
  // ever reused for another chat. Without it, the save below would write one
  // chat's words into the next one.
  const draftLoadedFor = useRef(sessionId);
  useEffect(() => {
    if (draftLoadedFor.current === sessionId) return;
    draftLoadedFor.current = sessionId;
    const parked = loadDraft(sessionId);
    setDraft(parked?.text ?? '');
    setPendingImages(parked?.images ?? []);
  }, [sessionId]);

  useEffect(() => {
    const t = setTimeout(() => saveDraft(sessionId, latestDraft.current), 400);
    return () => clearTimeout(t);
  }, [sessionId, draft, pendingImages]);

  // Mirror the draft into the store (undebounced) so the Context Inspector on
  // the right counts what you're typing at the same moment the composer's own
  // gauge does.
  useEffect(() => { useStore.getState().setSessionDraft(sessionId, draft); }, [sessionId, draft]);

  // Flush on unmount (tab switch, leaving the Chat view) and on window close, so
  // the last keystrokes can't be lost inside the debounce window.
  useEffect(() => {
    const flush = () => saveDraft(sessionId, latestDraft.current);
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, [sessionId]);

  // Focus the composer when a chat opens so you can start typing straight away,
  // caret after any restored draft. Runs once per chat, and never steals focus
  // from something else you're already typing in. The provider count is a
  // dependency because the textarea is disabled until providers have loaded.
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el || el.disabled || focusedFor.current === sessionId) return;
    const active = document.activeElement;
    const typingElsewhere =
      active instanceof HTMLElement &&
      active !== el &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (typingElsewhere) return;
    focusedFor.current = sessionId;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [sessionId, providers.length]);

  const beginTurn = () => {
    setStreaming(true);
    if (flushTimer.current != null) clearTimeout(flushTimer.current);
    flushTimer.current = null;
    pendingText.current = '';
    pendingReasoning.current = '';
    setLiveText('');
    setLiveReasoning('');
    setLiveTools([]);
    setThinking(false);
    setReasoningDuration(null);
    setDoneSummary(null);
    setErrorNotice(null);
    // The reply they suggested against is about to be replaced.
    setSuggestions(null);
    reasoningStart.current = 0;
    turnStart.current = Date.now();
    turnOutRef.current = 0;
    turnDecodeMsRef.current = 0;
    turnCostRef.current = 0;
    pendingOutRef.current = 0;
    // The prompt is priced from the context gauge's own count the instant the
    // turn starts, so the figure is never a zero that sits there while a large
    // prompt is being processed.
    pendingInRef.current = (ctx?.items ?? []).filter((i) => i.included).reduce((n, i) => n + i.tokens, 0);
    setTurnCost(estimateCostUSD(modelForCostRef.current ?? undefined, pendingInRef.current, 0));
    liveToolsRef.current = [];
    liveTextRef.current = '';
    liveCtxRef.current = 0;
    setLiveCtxTokens(0);
    setTurnOut(0);
    setElapsed(0);
    setMascotMood('thinking');
    // Sending pins the reader to the bottom for the reply.
    pinnedRef.current = true;
    setShowJump(false);
  };

  // Tick the elapsed-seconds counter while a turn is streaming (for the subtext).
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => {
      if (turnStart.current) setElapsed(Math.round((Date.now() - turnStart.current) / 1000));
    }, 500);
    return () => clearInterval(t);
  }, [streaming]);

  // This chat's Auto profile: how hard Auto leans on capability (Cheap / Normal
  // / Quality). Per-chat, because a throwaway question and a refactor rarely
  // want the same spend.
  const autoQuality: AutoQuality = session?.autoQuality ?? 'normal';

  /** Resolve Auto mode against a prompt, with the reasoning for the chip. */
  const autoPickFor = (text: string) => {
    const favSet = new Set(settings?.favoriteModels ?? []);
    const favs = new Set(models.filter((m) => favSet.has(`${providerId}::${m.id}`)).map((m) => m.id));
    // Auto never reaches for a model the plan can't serve right now: picking a
    // capped model is a turn that fails on send rather than a smarter choice.
    return pickAutoModel(runnableModels, text, { quality: autoQuality, preferred: favs });
  };

  // The concrete model to run this reply on: the picked one, or, in Auto mode -
  // the best available model for the prompt (favorites break ties).
  const resolveModelId = (text: string): string | null => {
    if (modelId !== AUTO_MODEL_ID) return modelId;
    return autoPickFor(text)?.modelId ?? null;
  };

  /**
   * The provider + model this turn will run on, or null after saying what's
   * missing. Sending used to fail silently here, which read as "the send button
   * is broken": the most common way in was switching tabs, since the workbench
   * unmounts a pane and the rebuilt one can land on a provider with no models.
   */
  const requireBrain = (text: string): { providerId: string; modelId: string } | null => {
    const toast = (message: string) => useStore.getState().pushToast('error', message);
    if (!providerId) {
      toast(providers.length === 0
        ? 'Add a model provider in Model Providers first.'
        : 'This chat is still loading its model, try again in a moment.');
      return null;
    }
    const resolved = resolveModelId(text);
    if (!resolved) {
      const label = providers.find((p) => p.id === providerId)?.label ?? 'this provider';
      toast(models.length === 0
        ? `No models available from ${label}. Start it, or pick another model below the chat.`
        : 'Pick a model below the chat first.');
      // Open the picker rather than leaving them to hunt for it.
      setModelMenuOpen(true);
      return null;
    }
    // Remembered here rather than at each call site: every turn goes through
    // this gate, so this is the one place that always knows what will run.
    modelForCostRef.current = resolved;
    return { providerId, modelId: resolved };
  };

  const send = async (override?: string) => {
    const input = override ?? draft;
    const skill = activeSkill;
    // A plan only reaches the agent when the rail's checkbox says so, so the
    // panel stays a scratchpad by default and becomes an instruction on request.
    const planBlock = session?.plan?.send ? planAsPromptBlock(session.plan) : '';
    const text = [
      skill ? skill.template.trimEnd() : '',
      input.trim(),
      planBlock,
    ].filter(Boolean).join('\n\n');
    const images = pendingImages;
    if (!text.trim() && images.length === 0 && !skill) return;

    // The `goal` skill: `/goal <condition>` starts a long-running background
    // agent that keeps working until the condition is met (not a one-off turn).
    const goalMatch = text.match(/^\/goal\s+([\s\S]+)/i);
    if (goalMatch) {
      const goal = goalMatch[1].trim();
      const brain = requireBrain(goal);
      if (!brain) return;
      await window.nekko.createTask({
        title: `Goal: ${goal.slice(0, 40)}`,
        kind: 'background',
        keepAlive: 'until',
        condition: goal,
        prompt: `Work autonomously toward this goal: ${goal}`,
        workspaceId: session?.workspaceId,
        providerId: brain.providerId,
        modelId: brain.modelId,
        intervalMs: 5 * 60_000,
      });
      useStore.getState().pushToast('success', 'Goal started as a background task, track it in Command Center.');
      if (override === undefined) { setDraft(''); clearDraft(sessionId); }
      return;
    }

    const brain = requireBrain(text);
    if (!brain) return;
    if (override === undefined) { setDraft(''); setPendingImages([]); clearDraft(sessionId); }
    setActiveSkill(null);
    beginTurn();
    setSession((prev) =>
      prev ? {
        ...prev,
        messages: [...prev.messages, {
          id: 'tmp',
          role: 'user',
          content: text,
          ...(images.length ? { images } : {}),
          ...(skill ? { skill: { name: skill.name, input } } : {}),
          createdAt: Date.now(),
        }],
      } : prev,
    );
    await window.nekko.sendChat({
      sessionId,
      providerId: brain.providerId,
      modelId: brain.modelId,
      text,
      ...(images.length ? { images } : {}),
      ...(skill ? { skill: { name: skill.name, input } } : {}),
    });

    // Auto-file a project-less chat under the project it's about, inferred from
    // its attachments + first prompt, so it lands in the right sidebar group.
    // A general chat (no confident match) simply stays under "General".
    if (session && !session.workspaceId) {
      const workspaces = useStore.getState().settings?.workspaces ?? [];
      const wsId = detectSessionWorkspace({ text, workspaces, attachedPaths: session.attachedPaths ?? [] });
      if (wsId) {
        const updated = await window.nekko.setSessionWorkspace(sessionId, wsId);
        if (updated) setSession(updated);
        useStore.getState().refreshSessions();
      }
    }
  };

  // Queue the draft to run after the current reply (and any earlier queued
  // items). Useful for lining up follow-ups while an agent is working.
  const queueDraft = async () => {
    const text = draft.trim();
    if (!text) return;
    const updated = await window.nekko.queuePrompt(sessionId, text);
    setDraft('');
    clearDraft(sessionId);
    if (updated) setSession(updated);
    refreshSessions();
  };

  /**
   * Park the plan on the session. The rail edits it constantly (every keystroke
   * re-decodes an untouched plan), so this writes through rather than holding a
   * second copy in renderer state that could drift from what a reload sees.
   */
  const savePlan = (plan: PromptPlan | undefined) => {
    setSession((prev) => (prev ? { ...prev, plan } : prev));
    window.nekko.setSessionOptions(sessionId, { plan }).catch(() => {});
  };

  const removeQueued = async (index: number) => {
    const updated = await window.nekko.dequeuePrompt(sessionId, index);
    if (updated) setSession(updated);
    refreshSessions();
  };

  // A comment/note routed here from the editor or design board: drop it into the
  // draft ("Add to prompt") or send it now ("Run now"). Wait for the provider to
  // be ready (a freshly-opened pane loads it async) before a run-now fires.
  const composerInbox = useStore((s) => s.composerInbox);
  useEffect(() => {
    if (!composerInbox || composerInbox.sessionId !== sessionId) return;
    if (composerInbox.run && (!providerId || streaming)) return;
    const { text, run } = composerInbox;
    useStore.setState({ composerInbox: null });
    if (run) void send(text);
    else { setDraft((d) => (d.trim() ? d + '\n\n' : '') + text); composerRef.current?.focus(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerInbox, sessionId, providerId, streaming]);

  const editResend = async (messageId: string, newText: string) => {
    if (!newText.trim()) return;
    const brain = requireBrain(newText);
    if (!brain) return;
    await window.nekko.truncateSession(sessionId, messageId);
    beginTurn();
    setSession((prev) => {
      if (!prev) return prev;
      const idx = prev.messages.findIndex((m) => m.id === messageId);
      const kept = idx >= 0 ? prev.messages.slice(0, idx) : prev.messages;
      return { ...prev, messages: [...kept, { id: 'tmp', role: 'user', content: newText, createdAt: Date.now() }] };
    });
    await window.nekko.sendChat({ sessionId, providerId: brain.providerId, modelId: brain.modelId, text: newText });
  };

  // Carry on from a reply that stopped part-way. The transcript is left exactly
  // as it is: every step already taken, and every tool result it produced, stays
  // and is not run again. This is the non-destructive counterpart to startOver.
  const resumeRun = async () => {
    // Resolve the model against the prompt this run is still working on, so Auto
    // mode picks the same tier it picked when the run started.
    const lastUser = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'user');
    const brain = requireBrain(lastUser?.content ?? '');
    if (!brain) return;
    setErrorNotice(null);
    beginTurn();
    await window.nekko.sendChat({
      sessionId,
      providerId: brain.providerId,
      modelId: brain.modelId,
      text: '',
      resume: true,
    });
  };

  // Re-run the last user message from scratch, discarding what the failed turn
  // produced. Destructive, so it's the secondary action next to Resume.
  const startOver = () => {
    const lastUser = [...(session?.messages ?? [])].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    setErrorNotice(null);
    void editResend(lastUser.id, lastUser.content);
  };

  const exportChat = () => {
    if (!session) return;
    const lines = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `## ${m.role === 'user' ? 'You' : 'Agent Nekko'}\n\n${m.content}`);
    const md = `# ${session.title}\n\n${lines.join('\n\n')}\n`;
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(session.title || 'chat').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const approve = async (okDecision: boolean) => {
    if (!approval) return;
    await window.nekko.approveTool(sessionId, approval.call.id, okDecision);
    setApproval(null);
  };

  /** Unblock the turn. Clearing first keeps the card from lingering over the
   *  reply that the answer immediately produces. */
  const answerQuestion = async (answers: AskAnswer[]) => {
    const pending = question;
    if (!pending) return;
    setQuestion(null);
    await window.nekko.answerQuestion(sessionId, pending.callId, answers);
  };

  const hasProvider = providers.length > 0;
  const slashQuery = draft.startsWith('/') && !draft.includes('\n') ? draft.slice(1).toLowerCase() : null;
  const slashMatches =
    slashQuery !== null ? (settings?.prompts ?? []).filter((p) => p.name.toLowerCase().includes(slashQuery)) : [];
  // Skills (standard agent skills + installed marketplace skills) show in the
  // `/` menu until the user types args.
  const installedSkillDefs = useStore((s) => s.installedSkillDefs);
  const skillMatches = slashQuery !== null && !slashQuery.includes(' ') ? matchSkills(slashQuery, installedSkillDefs) : [];
  // Every skill this chat can run, in the same order `/` offers them (built-ins
  // plus installed, highlighted first). The + menu lists these.
  const allSkills = matchSkills('', installedSkillDefs);
  const slashMenuOpen = !menuClosed && (skillMatches.length > 0 || slashMatches.length > 0);

  const atQuery = (draft.match(/(?:^|\s)@([^\s@]*)$/) ?? [])[1] ?? null;
  const atMatches =
    atQuery !== null ? atFiles.filter((f) => f.relPath.toLowerCase().includes(atQuery.toLowerCase())).slice(0, 8) : [];
  const atMenuOpen = !menuClosed && atQuery !== null && !!session?.workspaceId;

  // Reset the highlighted menu row whenever the query changes.
  useEffect(() => { setMenuSel(0); }, [slashQuery, atQuery]);

  useEffect(() => { setAtFiles([]); }, [session?.workspaceId]);
  useEffect(() => {
    if (atQuery !== null && session?.workspaceId && atFiles.length === 0) {
      window.nekko.listFiles(session.workspaceId).then(setAtFiles).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atQuery, session?.workspaceId]);

  /** Close the + menu (and its skills flyout). */
  const closeAttachMenu = (refocus = false) => {
    setAttachMenuOpen(false);
    setSkillsHover(false);
    if (skillsFlyTimer.current) { clearTimeout(skillsFlyTimer.current); skillsFlyTimer.current = null; }
    if (refocus) attachButtonRef.current?.focus();
  };

  // Hover-intent for the Skill flyout: open immediately, close on a short delay
  // so the pointer can travel from the row to the flyout without it collapsing.
  const openSkillsFly = () => {
    if (skillsFlyTimer.current) { clearTimeout(skillsFlyTimer.current); skillsFlyTimer.current = null; }
    setSkillsHover(true);
  };
  const closeSkillsFly = () => {
    if (skillsFlyTimer.current) clearTimeout(skillsFlyTimer.current);
    skillsFlyTimer.current = window.setTimeout(() => setSkillsHover(false), 140);
  };

  const armSkill = (sk: SkillDef) => {
    if (sk.kind === 'goal') {
      setActiveSkill(null);
      setDraft('/goal ');
    } else {
      setActiveSkill(sk);
      setDraft('');
    }
    composerRef.current?.focus();
  };

  // Pick a slash-menu row by its combined index (skills first, then prompts).
  const pickSlashIndex = (i: number) => {
    if (i < skillMatches.length) {
      armSkill(skillMatches[i]);
      return;
    }
    const p = slashMatches[i - skillMatches.length];
    if (p) { setDraft(p.body); composerRef.current?.focus(); }
  };

  const pickFile = async (f: IndexedFile) => {
    if (!session) return;
    const next = Array.from(new Set([...(session.attachedPaths ?? []), f.path]));
    await window.nekko.setSessionAttachments(session.id, next);
    setDraft((d) => d.replace(/(?:^|\s)@([^\s@]*)$/, (full) => (/^\s/.test(full) ? ' ' : '') + '@' + f.relPath + ' '));
    setSession(await window.nekko.getSession(session.id));
    refreshCtx();
    composerRef.current?.focus();
  };

  // Suggestions only count while the reply they were written for is still the
  // latest word; anything newer retires them.
  const lastMsgId = session?.messages[session.messages.length - 1]?.id;
  const liveSuggestions = suggestions && suggestions.forId === lastMsgId ? suggestions : null;
  // The model's single most likely next message, shown as the composer's
  // placeholder while the box is empty; ArrowRight types it in.
  const ghostSuggestion = !draft && liveSuggestions?.next ? liveSuggestions.next : null;

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const menuCount = slashMenuOpen ? skillMatches.length + slashMatches.length : atMenuOpen ? atMatches.length : 0;
    if (slashMenuOpen || atMenuOpen) {
      // Escape closes the menu and keeps the draft; typing re-opens it.
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuClosed(true);
        return;
      }
      if (menuCount > 0) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setMenuSel((s) => (s + 1) % menuCount); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setMenuSel((s) => (s - 1 + menuCount) % menuCount); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const i = Math.min(menuSel, menuCount - 1);
          if (slashMenuOpen) pickSlashIndex(i);
          else void pickFile(atMatches[i]);
          return;
        }
      }
    }
    // → accepts the ghost suggestion while the box is empty (the box is empty
    // whenever a ghost is showing, so the caret is already at the end).
    if (e.key === 'ArrowRight' && ghostSuggestion && !e.currentTarget.value) {
      e.preventDefault();
      const el = e.currentTarget;
      setDraft(ghostSuggestion);
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const openImageMenu = (e: React.MouseEvent, src: string) => {
    e.preventDefault();
    e.stopPropagation();
    setImageMenu({ x: e.clientX, y: e.clientY, src });
  };

  const addImages = async (files: File[]) => {
    const images = await Promise.all(files.map((file) => readImage(file).catch(() => null)));
    setPendingImages((current) => [...current, ...images.filter((image): image is string => !!image)]);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length) {
      e.preventDefault();
      void addImages(files);
    }
  };

  const addFiles = async () => {
    const picked = await window.nekko.openFilesDialog();
    if (!session || !picked.length) return;
    const next = Array.from(new Set([...(session.attachedPaths ?? []), ...picked]));
    await window.nekko.setSessionAttachments(session.id, next);
    setSession(await window.nekko.getSession(session.id));
    refreshCtx();
  };

  const providerKind = providers.find((p) => p.id === providerId)?.kind;
  const activeProvider = providers.find((p) => p.id === providerId);
  // This provider's live usage windows, and the models they still leave usable.
  const providerLimits = useProviderLimits(activeProvider);
  const runnableModels = models.filter(
    (m) => resolveModelAvailability({ model: m, provider: activeProvider, limits: providerLimits }).status === 'ready',
  );
  const isCloudModel = !providerKind || !isLocalProvider(providerKind);
  const isSubscription = activeProvider?.auth === 'subscription';
  // Reasoning toggle: offered only for a concrete, reasoning-capable model.
  const selectedModelInfo = modelId && modelId !== AUTO_MODEL_ID ? models.find((m) => m.id === modelId) : undefined;
  const thinkingSupported = !!modelId && modelId !== AUTO_MODEL_ID && modelSupportsThinking({ id: modelId, name: selectedModelInfo?.name });
  const thinkingOn = session?.thinking !== false;
  const setThinkingPref = (value: boolean) => {
    window.nekko.setSessionOptions(sessionId, { thinking: value }).then((s) => { if (s) setSession(s); }).catch(() => {});
  };

  // Auto mode: the model the next message will actually run on. Shown whether or
  // not anything is typed yet - "Auto" alone tells you nothing, and the pick
  // moves as you type, which is exactly what's worth watching.
  const autoPick = modelId === AUTO_MODEL_ID ? autoPickFor(draft) : null;

  // Nothing picked yet, but there is something to pick from: guide the choice
  // instead of failing on send.
  const needsModel = hasProvider && modelsLoaded && !modelId;
  // A tooltip on the model chip, not a banner in the strip: the nudge points at
  // the control that answers it and costs no layout while it waits.
  const modelHint =
    needsModel && !modelHintDone
      ? models.length === 0
        ? 'This provider has no models loaded. Start it, or switch provider in here.'
        : 'This chat needs a model before it can reply.'
      : null;
  // Any route into the picker counts as the nudge being read.
  const openModelMenu = (open: boolean) => {
    setModelMenuOpen(open);
    if (open) setModelHintDone(true);
  };

  /**
   * What this reply is doing right now, in a few words.
   *
   * Read off the app-wide fold rather than recomputed here, so the phrase under
   * the transcript and the one on the chat's Command Center card are the same
   * sentence. Subscribing to the run is what makes it move: it changes on every
   * tool call and thought, where the old label said "Streaming" for the whole
   * turn regardless of what the agent was actually doing.
   */
  const liveRun = useLiveRun(sessionId);
  const liveStatus = streaming ? shortLiveStatus(liveRun?.activity) || 'Working' : '';

  // The in-flight turn's reasoning + tool calls, folded into one activity block.
  const liveActivity: Activity[] = [
    ...(liveReasoning ? [{ kind: 'reasoning' as const, text: liveReasoning, duration: reasoningDuration }] : []),
    ...liveTools.map((c) => ({ kind: 'tool' as const, call: c })),
  ];

  const queued = session?.queue ?? [];

  /**
   * How wide the conversation and its controls run inside the pane.
   *
   * Three quarters, not a fixed 768px column: on a desktop workbench pane the
   * old cap left the composer at about half the width with dead margin on both
   * sides. When the plan rail is showing it already takes the right quarter, so
   * the column below it goes full width rather than indenting twice.
   */
  const contentWidth = planRailOpen || paneWidth < NARROW_PANE ? 'mx-auto w-full' : 'mx-auto w-[75%]';

  return (
    <div ref={paneRef} className="flex h-full min-w-0 overflow-hidden">
      <section className="flex min-w-0 w-full flex-1 flex-col overflow-x-hidden">
        {/* One bar per window. Inside a workspace these ride in the frame's
            title strip, which already shows the chat's name; standalone, the
            chat still needs a header of its own. */}
        <ChatHeader title={session?.title || 'New chat'} subAgent={Boolean(session?.parentSessionId)}>
            {git && (
              <span className="flex min-w-0 shrink items-center gap-1 text-[11px]">
                {git.worktree && (
                  <span
                    className="inline-flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-px"
                    style={{ background: 'color-mix(in srgb, var(--accent-2) 13%, transparent)', color: 'var(--accent-2)' }}
                    title={`Linked git worktree: ${git.worktree.path}`}
                  >
                    <WorktreeIcon className="h-3 w-3 shrink-0" />
                    <span className="truncate">{git.worktree.name}</span>
                  </span>
                )}
                <span
                  className="inline-flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-px"
                  style={{ background: 'color-mix(in srgb, var(--accent) 13%, transparent)', color: 'var(--accent)' }}
                  title={git.branch ? `On branch ${git.branch}${git.dirtyCount ? ` · ${git.dirtyCount} uncommitted` : ''}` : `Detached at ${git.head}`}
                >
                  <BranchIcon className="h-3 w-3 shrink-0" />
                  <span className="max-w-[16ch] truncate">{git.branch ?? git.head ?? 'detached'}</span>
                </span>
              </span>
            )}
            {headerPrs.length > 0 && (
              <button
                className="btn btn-ghost px-2 py-1"
                onClick={() => useStore.getState().openPrPane(headerPrs[0].url)}
                title={git?.pr ? `Review #${git.pr.number}: ${git.pr.title}` : 'Review pull request'}
              >
                <PrBadge prs={headerPrs} />
              </button>
            )}
            {changeCount > 0 && (
              <button
                className="btn btn-ghost px-2 py-1 text-[12px] font-medium text-accent"
                onClick={() => useStore.getState().openDiffPane(sessionId)}
                title="Review the agent's file changes"
              >
                {changeCount} change{changeCount === 1 ? '' : 's'}
              </button>
            )}
            <button
              className="btn btn-ghost px-2 py-1 text-[11px]"
              onClick={() => useStore.getState().openTerminalPane(`agent_${sessionId}`)}
              title="Open the agent's command log in a terminal window"
            >
              Commands
            </button>
            {!!session?.messages.length && (
              <button className="btn btn-ghost px-2 py-1" onClick={exportChat} title="Export chat as Markdown"><DownloadIcon /></button>
            )}
            {wideEnoughForRail && (
              <button
                className={`btn btn-ghost px-2 py-1 ${planRailOpen ? 'text-accent' : ''}`}
                onClick={() => useStore.getState().togglePlanRail()}
                title="Toggle the plan, sub-agents, and queue panel"
                aria-pressed={planRailOpen}
              >
                <ListIcon className="h-4 w-4" />
              </button>
            )}
            <button
              className={`btn btn-ghost hidden px-2 py-1 lg:inline-flex ${ctxOpen ? 'text-accent' : ''}`}
              onClick={() => useStore.getState().toggleContextPanel()}
              title="Toggle context panel (Ctrl/⌘+\)"
              aria-pressed={ctxOpen}
            >
              <PanelIcon />
            </button>
        </ChatHeader>

        <div className="relative flex min-h-0 w-full flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="w-full flex-1 overflow-y-auto overflow-x-hidden px-4 py-5">
            <div className={`${contentWidth} space-y-5`}>
              {!session?.messages.length && !liveText && !liveReasoning && (
                <div className="fade-in mt-16 flex flex-col items-center gap-3 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={30} /></div>
                  <div>
                    <h2 className="text-[15px] font-semibold">
                      {!hasProvider ? 'Connect a model to get started' : needsModel ? 'Pick a model to get started' : 'What should Agent Nekko work on?'}
                    </h2>
                    <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-faint">
                      {!hasProvider
                        ? 'Add a local server (Ollama, LM Studio, vLLM) or a cloud provider in Model Providers.'
                        : needsModel
                          ? 'This chat has no model yet. Choose one below the composer, or let ✨ Auto pick per message.'
                          : 'Ask a question or hand over a task. Use / for skills and prompts, @ to attach files, + for photos and folders.'}
                    </p>
                  </div>
                  {!hasProvider ? (
                    <button className="btn btn-primary" onClick={() => useStore.getState().setView('models')}>Open Model Providers</button>
                  ) : needsModel ? (
                    <button className="btn btn-primary" onClick={() => openModelMenu(true)}>Choose a model</button>
                  ) : null}
                </div>
              )}
              {session && (() => {
                const shown = new Set<string>();
                const prByUrl = new Map(prs.map((p) => [p.url, p]));
                const blocks = toStreamBlocks(session.messages);
                const rendered = blocks.map((b, i) => {
                  if (b.type !== 'msg') return <ActivityGroup key={b.key} items={b.items} />;
                  const isUser = b.message.role === 'user';
                  const bubble = (
                    <MessageBubble
                      message={b.message}
                      onResend={!streaming && isUser && b.message.id !== 'tmp' ? editResend : undefined}
                      onReset={!streaming && isUser && b.message.id !== 'tmp' ? editResend : undefined}
                      onImageClick={setLightbox}
                      onImageContextMenu={openImageMenu}
                      chronological
                    />
                  );
                  // Surface a PR card right after the message that first names it.
                  const urls = isUser ? [] : extractPrUrls(b.message.content).filter((u) => !shown.has(u));
                  urls.forEach((u) => shown.add(u));
                  if (!urls.length) return <React.Fragment key={`${b.message.id}_${i}`}>{bubble}</React.Fragment>;
                  return (
                    <React.Fragment key={`${b.message.id}_${i}`}>
                      {bubble}
                      {urls.map((u) => <PrCard key={u} url={u} info={prByUrl.get(u)} sessionId={sessionId} />)}
                    </React.Fragment>
                  );
                });
                // PRs mentioned only in tool output (never in assistant text) still
                // get a card, appended after the transcript.
                const orphans = collectSessionPrUrls(session.messages).filter((u) => !shown.has(u));
                return (
                  <>
                    {rendered}
                    {orphans.map((u) => <PrCard key={`orphan_${u}`} url={u} info={prByUrl.get(u)} sessionId={sessionId} />)}
                  </>
                );
              })()}
              {liveActivity.length > 0 && <ActivityGroup items={liveActivity} streaming />}
              {liveText && <MessageBubble message={{ id: 'live', role: 'assistant', content: liveText, createdAt: 0 }} onImageClick={setLightbox} chronological />}
              {errorNotice && !streaming && (() => {
                // A stop the user asked for is not a failure, so it doesn't wear
                // the failure colour. Either way the run is resumable whenever it
                // left something behind: the steps it finished are on disk, so
                // Resume carries on rather than starting the work again.
                const stopped = errorNotice === 'Stopped';
                const canResume = hasResumableProgress(session?.messages ?? []);
                const tone = stopped ? 'var(--warning)' : 'var(--danger)';
                return (
                <div
                  className="fade-in flex items-center gap-2.5 rounded-xl border px-3 py-2 text-[12px]"
                  style={{
                    borderColor: `color-mix(in srgb, ${tone} 35%, transparent)`,
                    background: `color-mix(in srgb, ${tone} 7%, transparent)`,
                  }}
                  role="alert"
                >
                  <span className="shrink-0 font-medium" style={{ color: tone }}>
                    {stopped ? 'Reply stopped' : 'Reply failed'}
                  </span>
                  <span className="min-w-0 flex-1 text-ink-soft">
                    {stopped
                      ? canResume ? 'The work so far is saved.' : 'Nothing had started yet.'
                      : errorNotice}
                  </span>
                  {canResume && (
                    <button
                      className="btn btn-primary shrink-0 px-2.5 py-0.5 text-[11px]"
                      title="Carry on from here, keeping every step already done"
                      onClick={() => void resumeRun()}
                    >
                      Resume
                    </button>
                  )}
                  {session?.messages.some((m) => m.role === 'user') && (
                    <button
                      className="btn btn-outline shrink-0 px-2.5 py-0.5 text-[11px]"
                      title="Discard this reply and answer the prompt again from scratch"
                      onClick={startOver}
                    >
                      Start over
                    </button>
                  )}
                  <button className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink" title="Dismiss" onClick={() => setErrorNotice(null)}>
                    <CloseIcon className="h-3 w-3" />
                  </button>
                </div>
                );
              })()}
              <ContextWarning
                sessionId={sessionId}
                used={(ctx ? ctx.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0) : 0) + liveCtxTokens}
                windowTokens={selectedModelInfo?.contextLength ?? ctx?.contextWindow ?? 0}
                session={session}
                streaming={streaming}
                onCompacted={() => {
                  refreshCtx();
                  window.nekko.getSession(sessionId).then(setSession).catch(() => {});
                }}
              />
              <ReplyStatus
                streaming={streaming}
                status={liveStatus}
                elapsed={elapsed}
                tps={tps}
                out={turnOut}
                last={lastTurn}
                done={doneSummary}
              />
            </div>
          </div>
          {showJump && (
            <button
              className="fade-in absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line px-3 py-1 text-[12px] font-medium text-ink-soft shadow-md hover:text-ink"
              style={{ background: 'var(--surface)' }}
              onClick={jumpToLatest}
            >
              ↓ Jump to latest
            </button>
          )}
        </div>

        {approval && <ApprovalBar approval={approval} onDecide={approve} />}

        {question && (
          <div className="border-t border-line px-4 pt-3">
            <div className={contentWidth}>
              {/* Keyed so a second ask starts at its own first step rather
                  than inheriting where the last one was left. */}
              <QuestionCard
                key={question.callId}
                request={question}
                onAnswer={(answers) => answerQuestion(answers)}
                onSkip={() => answerQuestion([])}
              />
            </div>
          </div>
        )}

        <div ref={composerSectionRef} className="relative border-t border-line px-4 pb-4 pt-1.5">
          {/* The resize grip rides the composer's top border: a wide invisible
              hit area over a hairline that lights up on hover. */}
          <div
            className="group absolute inset-x-0 -top-1.5 z-10 h-3 cursor-row-resize"
            onPointerDown={startComposerResize}
            onDoubleClick={resetComposerHeight}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the message box"
            title="Drag to resize the message box · double-click to reset"
          >
            <span className="absolute inset-x-0 top-[5px] h-0.5 opacity-0 transition-opacity group-hover:opacity-100" style={{ background: 'color-mix(in srgb, var(--accent) 45%, transparent)' }} />
            <span className="absolute left-1/2 top-[3px] h-1.5 w-10 -translate-x-1/2 rounded-full opacity-0 transition-opacity group-hover:opacity-100" style={{ background: 'var(--accent)' }} />
          </div>
          <div className={contentWidth}>
            {/* The instrument strip, two rows so a long model name has room and
                nothing wraps: how this agent RUNS on top (mode + tools, with the
                privacy switches on the right), which BRAIN it uses underneath
                (model, reasoning, effort) plus the Automate action. The model
                chip is the flexible member of its row and truncates first. */}
            <div className="flex items-center gap-1.5 pb-1">
              <ChatControls session={session} isCloudModel={isCloudModel} onChange={setSession} />
            </div>
            <div className="flex items-center gap-1.5 pb-1.5">
              <ModelPicker
                providers={providers}
                providerId={providerId}
                models={models}
                modelId={modelId}
                open={modelMenuOpen}
                onOpenChange={openModelMenu}
                needsChoice={needsModel}
                hint={modelHint}
                onProvider={setProviderId}
                onModel={(pid, v) => {
                  if (pid) setProviderId(pid);
                  setModelId(v);
                  // Park the pick on the chat itself. Switching tabs unmounts
                  // this pane, so a renderer-only choice was lost on the way
                  // back and the chat fell back to its old provider (which may
                  // have no models at all, leaving it unsendable).
                  const auto = v === AUTO_MODEL_ID;
                  window.nekko
                    .setSessionOptions(sessionId, {
                      autoModel: auto,
                      ...(pid ? { providerId: pid } : {}),
                      ...(auto ? {} : { modelId: v }),
                    })
                    .then((s) => { if (s) setSession(s); })
                    .catch(() => {});
                }}
              />
              {modelId === AUTO_MODEL_ID && (
                <AutoQualityMenu
                  quality={autoQuality}
                  onPick={(q) => {
                    window.nekko
                      .setSessionOptions(sessionId, { autoQuality: q })
                      .then((s) => { if (s) setSession(s); })
                      .catch(() => {});
                  }}
                />
              )}
              {autoPick && (
                <span
                  className="min-w-0 shrink truncate text-[10px] text-ink-faint"
                  title={`Auto will run this message on ${autoPick.name}. ${autoPick.reason}`}
                >
                  → {autoPick.name}
                </span>
              )}
              {thinkingSupported ? (
                <button
                  className="ctl-toggle whitespace-nowrap"
                  onClick={() => setThinkingPref(!thinkingOn)}
                  aria-pressed={thinkingOn}
                  title={thinkingOn ? 'Reasoning is on for this chat — click to turn off' : 'Reasoning is off for this chat — click to turn on'}
                >
                  <span className={`ctl-dot ${thinkingOn && streaming ? 'animate-pulse' : ''}`} />
                  <ThoughtIcon className="h-3 w-3" /> Thinking {thinkingOn ? 'on' : 'off'}
                </button>
              ) : thinking ? (
                <span
                  className="ctl-toggle ctl-toggle-on whitespace-nowrap"
                  title="The model streamed reasoning while writing this reply"
                >
                  <span className={`ctl-dot ${streaming ? 'animate-pulse' : ''}`} />
                  <ThoughtIcon className="h-3 w-3" /> Thinking
                </span>
              ) : null}
              {/* Tied to the model this message will run on, so the rungs offered
                  are the ones that model actually has. */}
              <EffortMenu modelId={autoPick?.modelId ?? (modelId === AUTO_MODEL_ID ? undefined : modelId ?? undefined)} />
              <button
                className="ctl-toggle ml-auto shrink-0 whitespace-nowrap"
                onClick={() => setScheduleOpen(true)}
                aria-label="Automate: schedule, repeat, or run in the background"
                title="Automate: schedule, repeat, or run in the background"
              >
                <BoltIcon className="h-3 w-3" /> Automate
              </button>
            </div>

            {/* Queued follow-ups (animated in/out so the composer never jumps). */}
            <div className={`collapse-wrap ${queued.length > 0 ? '' : 'collapsed'}`} aria-hidden={queued.length === 0}>
              <div className="min-h-0 overflow-hidden">
                <div className="mb-2 rounded-xl border border-line bg-surface-2 px-3 py-2">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-faint">
                    <ListIcon className="h-3 w-3" /> Queued · {queued.length} to run after this
                  </div>
                  <div className="space-y-1">
                    {queued.map((q, i) => (
                      <div key={i} className="flex items-center gap-2 text-[12px]">
                        <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-soft" title={q}>{q}</span>
                        <button
                          className="shrink-0 rounded-sm px-1 text-ink-faint hover:text-(--danger)"
                          title="Remove from queue"
                          onClick={() => removeQueued(i)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <PromptAnalyzer
              text={draft}
              sessionId={sessionId}
              canModelFill={hasProvider}
              workspaces={settings?.workspaces ?? []}
              contextItems={ctx?.items ?? []}
              activeWorkspaceIds={session ? getSessionWorkspaceIds(session) : []}
              onFill={({ snippet, placement }) => {
                setDraft((d) =>
                  placement === 'start' ? `${snippet}\n\n${d.replace(/^\s+/, '')}` : `${d.replace(/\s+$/, '')}\n\n${snippet}`,
                );
                composerRef.current?.focus();
              }}
            />

            {/* Model-written follow-ups to the reply above: one click sends it
                outright, and starting any turn clears them. */}
            {liveSuggestions && liveSuggestions.options.length > 0 && !streaming && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Suggested replies">
                {liveSuggestions.options.map((opt) => (
                  <button
                    key={opt}
                    className="max-w-full truncate rounded-full border border-line bg-surface px-3 py-1.5 text-left text-[12px] text-ink-soft transition-colors hover:border-accent/50 hover:bg-surface-2 hover:text-ink"
                    title={`Send: ${opt}`}
                    onClick={() => { setSuggestions(null); void send(opt); }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            <div className="relative w-full">
              {atMenuOpen && (
                <div
                  className="card absolute bottom-full left-0 z-40 mb-2 w-full max-w-md overflow-hidden p-1.5 shadow-lg"
                  id={`at-menu-${sessionId}`}
                  role="listbox"
                  aria-label="Attach a file"
                >
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Attach a file</div>
                  {atMatches.length === 0 ? (
                    <div className="px-2.5 py-1.5 text-[11px] text-ink-faint">{atFiles.length === 0 ? 'Attach a project folder (+ → Folder) to mention its files.' : 'No matching files.'}</div>
                  ) : (
                    atMatches.map((f, i) => (
                      <button
                        key={f.path}
                        role="option"
                        aria-selected={i === menuSel}
                        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${i === menuSel ? 'bg-surface-2' : ''}`}
                        onClick={() => pickFile(f)}
                        onMouseEnter={() => setMenuSel(i)}
                      >
                        <span className="font-mono text-[12px] text-accent">@{f.relPath}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
              {slashMenuOpen && (
                <div
                  className="card absolute bottom-full left-0 z-40 mb-2 max-h-80 w-full max-w-md overflow-y-auto p-1.5 shadow-lg"
                  id={`slash-menu-${sessionId}`}
                  role="listbox"
                  aria-label="Skills and prompts"
                >
                  {skillMatches.length > 0 && (
                    <>
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Skills</div>
                      {skillMatches.map((sk, i) => (
                        <button
                          key={sk.id}
                          role="option"
                          aria-selected={i === menuSel}
                          className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${i === menuSel ? 'bg-surface-2' : ''}`}
                          onClick={() => armSkill(sk)}
                          onMouseEnter={() => setMenuSel(i)}
                          title={sk.description}
                        >
                          {sk.highlighted && <span className="text-[12px] text-accent">★</span>}
                          <span className="font-mono text-[13px] text-accent">/{sk.name}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{sk.description}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {slashMatches.length > 0 && (
                    <>
                      <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-faint">Prompts</div>
                      {slashMatches.map((p, i) => {
                        const idx = skillMatches.length + i;
                        return (
                          <button
                            key={p.id}
                            role="option"
                            aria-selected={idx === menuSel}
                            className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${idx === menuSel ? 'bg-surface-2' : ''}`}
                            onClick={() => { setDraft(p.body); composerRef.current?.focus(); }}
                            onMouseEnter={() => setMenuSel(idx)}
                          >
                            <span className="font-mono text-[13px] text-accent">/{p.name}</span>
                            <span className="truncate text-[11px] text-ink-faint">{p.body}</span>
                          </button>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
              <div className={streaming ? 'composer composer-beam' : 'composer'}>
                {/* Attachments ride inside the composer, at the top, separated by
                    a hairline. Floated above it they covered the instrument
                    strip. */}
                {pendingImages.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto border-b border-line px-3 py-2.5">
                    {pendingImages.map((image, i) => (
                      <div key={`${image.slice(0, 24)}-${i}`} className="group relative shrink-0">
                        <img
                          src={image}
                          alt={`Pending attachment ${i + 1}`}
                          className="h-16 w-16 cursor-pointer rounded-lg border border-line object-cover"
                          onClick={() => setLightbox(image)}
                          onContextMenu={(e) => openImageMenu(e, image)}
                          title="Click to preview · right-click to copy or save"
                        />
                        <button
                          className="absolute -right-1 -top-1 hidden h-4 w-4 rounded-full bg-ink text-[10px] leading-4 text-paper group-hover:block"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingImages((current) => current.filter((_, index) => index !== i));
                          }}
                          title="Remove image"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {activeSkill && (
                  <div className="flex items-center gap-2 px-3.5 pt-2.5">
                    <span className="skill-pill text-[12px]" title={activeSkill.description}>
                      <span className="skill-pill-slash">/</span>{activeSkill.name}
                      <button
                        className="ml-1 opacity-60 hover:opacity-100"
                        onClick={() => setActiveSkill(null)}
                        title="Remove skill"
                      >
                        ×
                      </button>
                    </span>
                    <span className="truncate text-[11px] text-ink-faint">
                      Runs on send · shown in context →
                    </span>
                  </div>
                )}
                <div className="relative">
                  {/* The → badge announces the ghost-accept key, top-right in the
                      textarea's padding so it never overlaps the text. */}
                  {ghostSuggestion && (
                    <span
                      className="pointer-events-none absolute right-3 top-3 z-10 select-none rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-faint"
                      aria-hidden
                    >
                      →
                    </span>
                  )}
                  <textarea
                    ref={composerRef}
                    className={`${composerH != null ? '' : 'max-h-60 '}min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 text-sm text-ink outline-hidden placeholder:text-ink-faint`}
                    rows={2}
                    placeholder={ghostSuggestion ?? (hasProvider ? 'Message Agent Nekko…  (/ for prompts, @ to attach files)' : 'Add a model provider in Model Providers first')}
                    value={draft}
                    role="combobox"
                    aria-expanded={slashMenuOpen || atMenuOpen}
                    aria-controls={slashMenuOpen ? `slash-menu-${sessionId}` : atMenuOpen ? `at-menu-${sessionId}` : undefined}
                    aria-autocomplete="list"
                    onChange={(e) => { setDraft(e.target.value); setMenuClosed(false); }}
                    onPaste={onPaste}
                    onKeyDown={onComposerKeyDown}
                    disabled={!hasProvider}
                  />
                </div>
                <div className="flex items-center gap-2 px-2 pb-2 pt-1">
                  <div
                    ref={attachMenuRef}
                    className="relative"
                    onKeyDown={(e) => {
                      if (e.key !== 'Escape' || !attachMenuOpen) return;
                      e.stopPropagation();
                      // Escape closes the skills flyout first, then the menu.
                      if (skillsHover) { setSkillsHover(false); }
                      else closeAttachMenu(true);
                    }}
                  >
                    <button
                      ref={attachButtonRef}
                      className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
                      onClick={() => (attachMenuOpen ? closeAttachMenu() : setAttachMenuOpen(true))}
                      title="Add a photo, file, folder, or skill"
                      aria-label="Add a photo, file, folder, or skill"
                      aria-haspopup="menu"
                      aria-expanded={attachMenuOpen}
                    >
                      <PlusIcon className="h-4 w-4" />
                    </button>
                    {attachMenuOpen && (
                      <div className="card absolute bottom-full left-0 z-40 mb-2 w-48 p-1.5 shadow-lg" role="menu">
                        <button
                          role="menuitem"
                          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
                          onClick={() => { closeAttachMenu(); imageInputRef.current?.click(); }}
                          onMouseEnter={closeSkillsFly}
                        >
                          Photo
                        </button>
                        <button
                          role="menuitem"
                          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
                          onClick={() => { closeAttachMenu(); void addFiles(); }}
                          onMouseEnter={closeSkillsFly}
                        >
                          File
                        </button>
                        <button
                          role="menuitem"
                          className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2"
                          onClick={() => { closeAttachMenu(); void window.nekko.addWorkspace(); }}
                          onMouseEnter={closeSkillsFly}
                        >
                          Folder
                        </button>
                        {/* Skills expand as a side flyout on hover, so someone new
                            finds them without knowing to type `/` or to click. */}
                        <div className="my-1 border-t border-line" />
                        <div className="relative" onMouseEnter={openSkillsFly} onMouseLeave={closeSkillsFly}>
                          <button
                            role="menuitem"
                            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] ${skillsHover ? 'bg-surface-2' : 'hover:bg-surface-2'}`}
                            onClick={() => setSkillsHover((v) => !v)}
                            onFocus={openSkillsFly}
                            aria-haspopup="menu"
                            aria-expanded={skillsHover}
                          >
                            <span className="flex-1">Skill</span>
                            {allSkills.length > 0 && (
                              <span className="tabular-nums text-[11px] text-ink-faint">{allSkills.length}</span>
                            )}
                            <span className="text-[10px] text-ink-faint">&#9656;</span>
                          </button>
                          {skillsHover && (
                            <div
                              className="card absolute bottom-0 left-full z-50 ml-1.5 w-72 p-1.5 shadow-lg"
                              role="menu"
                              aria-label="Skills"
                              onMouseEnter={openSkillsFly}
                              onMouseLeave={closeSkillsFly}
                            >
                              <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">Skills</div>
                              <div className="max-h-64 overflow-y-auto">
                                {allSkills.length === 0 && (
                                  <p className="px-2.5 py-2 text-[11px] text-ink-faint">
                                    No skills registered yet. Add one to run it from any chat.
                                  </p>
                                )}
                                {allSkills.map((sk) => (
                                  <button
                                    key={sk.id}
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2"
                                    onClick={() => { closeAttachMenu(); armSkill(sk); }}
                                    title={sk.description}
                                  >
                                    {sk.highlighted && <span className="shrink-0 text-[12px] text-accent">&#9733;</span>}
                                    <span className="shrink-0 font-mono text-[12px] text-accent">/{sk.name}</span>
                                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">{sk.description}</span>
                                  </button>
                                ))}
                              </div>
                              <div className="mt-1 border-t border-line pt-1">
                                <button
                                  role="menuitem"
                                  className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-accent hover:bg-surface-2"
                                  onClick={() => { closeAttachMenu(); useStore.getState().setView('skills'); }}
                                >
                                  <PlusIcon className="h-3.5 w-3.5" /> Add skill
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <input
                      ref={imageInputRef}
                      className="hidden"
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => {
                        const files = Array.from(e.target.files ?? []);
                        if (files.length) void addImages(files);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <ContextGauge
                    bundle={ctx}
                    subscription={isSubscription}
                    skill={activeSkill ? { name: activeSkill.name, tokens: estimateTokens(activeSkill.template) } : null}
                    draftTokens={draft.trim() ? estimateTokens(draft) : 0}
                    liveTokens={liveCtxTokens}
                    contextWindow={selectedModelInfo?.contextLength}
                  />
                  <UsageLimitsChip
                    provider={activeProvider}
                    session={session ?? undefined}
                    cost={cost}
                    turnCost={turnCost}
                    running={streaming}
                  />
                  <div className="flex-1" />
                  {draft.trim() && hasProvider && (
                    <button
                      className="btn btn-ghost h-8 px-2.5 py-0 text-[12px]"
                      onClick={queueDraft}
                      title={streaming ? 'Queue this to run after the current reply' : 'Queue this to run after any queued items'}
                    >
                      Queue
                    </button>
                  )}
                  {streaming ? (
                    <button className="btn btn-outline h-8 px-3 py-0 text-[12px]" onClick={() => window.nekko.abortChat(sessionId)}>Stop</button>
                  ) : (
                    <button
                      className="send-avatar grid h-9 w-9 shrink-0 place-items-center rounded-xl transition-all duration-150 disabled:opacity-40"
                      onClick={() => send()}
                      disabled={(!draft.trim() && pendingImages.length === 0 && !activeSkill) || !hasProvider}
                      title="Send"
                      aria-label="Send"
                    >
                      <NekkoAvatar size={24} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* The work rail, in the quarter the transcript gives back. Kept inside
          the chat pane (not the workbench's right panel) because everything in
          it belongs to this one conversation. */}
      {planRailOpen && (
        <div className="w-1/4 min-w-[224px] max-w-[320px] shrink-0">
          <PlanRail
            sessionId={sessionId}
            session={session}
            draft={draft}
            streaming={streaming}
            onPlanChange={savePlan}
            onClose={() => useStore.getState().togglePlanRail()}
          />
        </div>
      )}

      {scheduleOpen && (
        <ScheduleTaskModal
          workspaceId={session?.workspaceId}
          providerId={providerId ?? undefined}
          modelId={modelId && modelId !== AUTO_MODEL_ID ? modelId : undefined}
          initialPrompt={draft.trim() || undefined}
          onClose={() => setScheduleOpen(false)}
        />
      )}
      {lightbox && (
        <Modal
          title="Attached image"
          onClose={() => setLightbox(null)}
          scrim="rgba(0,0,0,0.5)"
          overlayClassName="p-4"
        >
          <img
            src={lightbox}
            alt="Full-size attachment"
            className="max-h-[90vh] max-w-[90vw] object-contain"
            onContextMenu={(e) => openImageMenu(e, lightbox)}
            title="Right-click to copy or save"
          />
        </Modal>
      )}
      {imageMenu && (
        <ImageMenu x={imageMenu.x} y={imageMenu.y} src={imageMenu.src} onClose={() => setImageMenu(null)} />
      )}
    </div>
  );
}

