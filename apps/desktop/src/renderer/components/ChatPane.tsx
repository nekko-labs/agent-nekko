import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentEvent, AutoQuality, ChatMessage, Session, ToolCall, ContextBundle, IndexedFile, ModelInfo, ProviderConfig, SkillDef, PrInfo } from '@agent-nekko/shared';
import { pickAutoModel, AUTO_MODEL_ID, AUTO_QUALITIES, AUTO_QUALITY_META, matchSkills, estimateTokens, modelSupportsThinking, getSessionWorkspaceIds, extractPrUrls, collectSessionPrUrls, detectSessionWorkspace, decodeRate, formatRate, hasResumableProgress, isLocalProvider, formatModelPriceLabel } from '@agent-nekko/shared';
import { useStore } from '../store.js';
import { clearDraft, loadDraft, saveDraft } from '../composerDrafts.js';
import { Markdown } from './Markdown.js';
import { ContextGauge, EffortMenu } from './ChatMetrics.js';
import { UsageLimitsChip } from './UsageLimitsChip.js';
import { ContextWarning } from './ContextWarning.js';
import { ChatControls } from './ChatControls.js';
import { PromptAnalyzer } from './PromptAnalyzer.js';
import { ScheduleTaskModal } from './ScheduleTaskModal.js';
import { PrCard, PrBadge } from './PrCard.js';
import { MiniNekko, NekkoAvatar } from './Mascot.js';
import { Modal } from './primitives/index.js';
import { PanelIcon, ShieldIcon, DownloadIcon, PlusIcon, CloseIcon, BoltIcon, ThoughtIcon, ListIcon, ToolStepIcon, RobotIcon, StarIcon } from '../icons.js';

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
  a.download = `kotrain-image.${ext === 'jpeg' ? 'jpg' : ext || 'png'}`;
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

interface PendingApproval {
  call: ToolCall;
  reason: string;
  severity: 'low' | 'medium' | 'high';
}

/**
 * One chat conversation, fully self-contained so several can run side by side in
 * the workbench. Provider/model are chosen per-pane (independent agents); the
 * pane subscribes to agent events filtered by its own sessionId.
 */
export function ChatPane({ sessionId, onRunningChange }: { sessionId: string; onRunningChange?: (running: boolean) => void }) {
  const { providers, settings, setMascotMood, refreshSessions, activeWorkspaceId } = useStore();

  const [session, setSession] = useState<Session | null>(null);
  // Seed the composer from whatever was parked for this chat, so an unsent
  // message survives a tab switch or a restart.
  const [draft, setDraft] = useState(() => loadDraft(sessionId)?.text ?? '');
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [liveReasoning, setLiveReasoning] = useState('');
  const [liveTools, setLiveTools] = useState<ToolCall[]>([]);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [ctx, setCtx] = useState<ContextBundle | null>(null);
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
  // The armed skill lives in the store (per session) so the Context Inspector on
  // the right can show it and count its tokens while it's active.
  const activeSkill = useStore((s) => s.activeSkillBySession[sessionId] ?? null);
  const setActiveSkill = (skill: SkillDef | null) => useStore.getState().setActiveSkill(sessionId, skill);
  // PRs referenced in this chat (for the header badge + inline cards).
  const prs = useStore((s) => s.prsBySession[sessionId] ?? NO_PRS);
  const [lightbox, setLightbox] = useState<string | null>(null);
  // Right-click menu for a chat image (copy / save), placed at the pointer.
  const [imageMenu, setImageMenu] = useState<{ x: number; y: number; src: string } | null>(null);
  const [reasoningDuration, setReasoningDuration] = useState<number | null>(null);
  const [changeCount, setChangeCount] = useState(0);
  const [doneSummary, setDoneSummary] = useState<string | null>(null);
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
    const load = () => window.kotrain.listChanges(sessionId).then((c) => { if (live) setChangeCount(c.length); }).catch(() => {});
    load();
    const off = window.kotrain.onChangesUpdated((e) => { if (e.sessionId === sessionId) load(); });
    return () => { live = false; off(); };
  }, [sessionId]);

  useEffect(() => onRunningChange?.(streaming), [streaming, onRunningChange]);

  const refreshCtx = () => {
    window.kotrain.previewContext(sessionId, []).then(setCtx).catch(() => setCtx(null));
  };

  // Load the session; seed provider/model from it (or the global defaults).
  useEffect(() => {
    window.kotrain.getSession(sessionId).then((s) => {
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
    window.kotrain.listModels(providerId).then((m) => {
      setModels(m);
      setModelId((cur) => (cur === AUTO_MODEL_ID || (cur && m.some((x) => x.id === cur)) ? cur : null));
      setModelsLoaded(true);
    }).catch(() => { setModels([]); setModelsLoaded(true); });
  }, [providerId]);

  // Per-chat estimated cost. usageSummary already zeroes subscription providers.
  useEffect(() => {
    window.kotrain.getUsageSummary().then((u) => {
      const s = u.bySession[sessionId];
      setCost(s ? (s.cost ?? 0) : 0);
    }).catch(() => setCost(0));
  }, [sessionId, session?.modelId, session?.messages.length]);

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

  // Stream agent events for this session only.
  useEffect(() => {
    const off = window.kotrain.onAgentEvent((e: AgentEvent) => {
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
          break;
        }
        case 'tool_call':
          if (reasoningStart.current) {
            setReasoningDuration(Math.round((Date.now() - reasoningStart.current) / 1000));
            reasoningStart.current = 0;
          }
          liveToolsRef.current = [...liveToolsRef.current, e.call];
          setLiveTools((tc) => [...tc, e.call]);
          break;
        case 'tool_approval_required':
          setApproval({ call: e.call, reason: e.reason, severity: e.severity });
          setMascotMood('thinking');
          break;
        case 'tool_result': setApproval(null); break;
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
          break;
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, setMascotMood]);

  const endTurn = () => {
    setStreaming(false);
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
    window.kotrain.getSession(sessionId).then((s) => {
      setSession(s);
      setLiveText('');
      setLiveReasoning('');
      setLiveTools([]);
    });
    refreshSessions();
    // A reply may have created or updated a PR (e.g. `gh pr create`).
    useStore.getState().refreshSessionPrs(sessionId);
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
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

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
    reasoningStart.current = 0;
    turnStart.current = Date.now();
    turnOutRef.current = 0;
    turnDecodeMsRef.current = 0;
    liveToolsRef.current = [];
    liveTextRef.current = '';
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
    return pickAutoModel(models, text, { quality: autoQuality, preferred: favs });
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
        ? 'Add a model provider in Models first.'
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
    return { providerId, modelId: resolved };
  };

  const send = async (override?: string) => {
    const input = override ?? draft;
    const skill = activeSkill;
    const text = skill
      ? [skill.template.trimEnd(), input.trim()].filter(Boolean).join('\n\n')
      : input;
    const images = pendingImages;
    if (!text.trim() && images.length === 0 && !skill) return;

    // The `goal` skill: `/goal <condition>` starts a long-running background
    // agent that keeps working until the condition is met (not a one-off turn).
    const goalMatch = text.match(/^\/goal\s+([\s\S]+)/i);
    if (goalMatch) {
      const goal = goalMatch[1].trim();
      const brain = requireBrain(goal);
      if (!brain) return;
      await window.kotrain.createTask({
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
    await window.kotrain.sendChat({
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
        const updated = await window.kotrain.setSessionWorkspace(sessionId, wsId);
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
    const updated = await window.kotrain.queuePrompt(sessionId, text);
    setDraft('');
    clearDraft(sessionId);
    if (updated) setSession(updated);
    refreshSessions();
  };

  const removeQueued = async (index: number) => {
    const updated = await window.kotrain.dequeuePrompt(sessionId, index);
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
    await window.kotrain.truncateSession(sessionId, messageId);
    beginTurn();
    setSession((prev) => {
      if (!prev) return prev;
      const idx = prev.messages.findIndex((m) => m.id === messageId);
      const kept = idx >= 0 ? prev.messages.slice(0, idx) : prev.messages;
      return { ...prev, messages: [...kept, { id: 'tmp', role: 'user', content: newText, createdAt: Date.now() }] };
    });
    await window.kotrain.sendChat({ sessionId, providerId: brain.providerId, modelId: brain.modelId, text: newText });
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
    await window.kotrain.sendChat({
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
    await window.kotrain.approveTool(sessionId, approval.call.id, okDecision);
    setApproval(null);
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
      window.kotrain.listFiles(session.workspaceId).then(setAtFiles).catch(() => {});
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
    await window.kotrain.setSessionAttachments(session.id, next);
    setDraft((d) => d.replace(/(?:^|\s)@([^\s@]*)$/, (full) => (/^\s/.test(full) ? ' ' : '') + '@' + f.relPath + ' '));
    setSession(await window.kotrain.getSession(session.id));
    refreshCtx();
    composerRef.current?.focus();
  };

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
    const picked = await window.kotrain.openFilesDialog();
    if (!session || !picked.length) return;
    const next = Array.from(new Set([...(session.attachedPaths ?? []), ...picked]));
    await window.kotrain.setSessionAttachments(session.id, next);
    setSession(await window.kotrain.getSession(session.id));
    refreshCtx();
  };

  const providerKind = providers.find((p) => p.id === providerId)?.kind;
  const activeProvider = providers.find((p) => p.id === providerId);
  const isCloudModel = !providerKind || !isLocalProvider(providerKind);
  const isSubscription = activeProvider?.auth === 'subscription';
  // Reasoning toggle: offered only for a concrete, reasoning-capable model.
  const selectedModelInfo = modelId && modelId !== AUTO_MODEL_ID ? models.find((m) => m.id === modelId) : undefined;
  const thinkingSupported = !!modelId && modelId !== AUTO_MODEL_ID && modelSupportsThinking({ id: modelId, name: selectedModelInfo?.name });
  const thinkingOn = session?.thinking !== false;
  const setThinkingPref = (value: boolean) => {
    window.kotrain.setSessionOptions(sessionId, { thinking: value }).then((s) => { if (s) setSession(s); }).catch(() => {});
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

  // The in-flight turn's reasoning + tool calls, folded into one activity block.
  const liveActivity: Activity[] = [
    ...(liveReasoning ? [{ kind: 'reasoning' as const, text: liveReasoning, duration: reasoningDuration }] : []),
    ...liveTools.map((c) => ({ kind: 'tool' as const, call: c })),
  ];

  const queued = session?.queue ?? [];

  return (
    <div className="flex h-full min-w-0 overflow-hidden">
      <section className="flex min-w-0 w-full flex-1 flex-col overflow-x-hidden">
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-[13px] font-medium">{session?.title || 'New chat'}</span>
            {session?.parentSessionId && <span className="chip shrink-0 text-[10px]">sub-agent</span>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {prs.length > 0 && (
              <button
                className="btn btn-ghost px-2 py-1"
                onClick={() => useStore.getState().openPrPane(prs[0].url)}
                title="Review pull request"
              >
                <PrBadge prs={prs} />
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
            {!!session?.messages.length && (
              <button className="btn btn-ghost px-2 py-1" onClick={exportChat} title="Export chat as Markdown"><DownloadIcon /></button>
            )}
            <button
              className={`btn btn-ghost hidden px-2 py-1 lg:inline-flex ${ctxOpen ? 'text-accent' : ''}`}
              onClick={() => useStore.getState().toggleContextPanel()}
              title="Toggle context panel (Ctrl/⌘+\)"
              aria-pressed={ctxOpen}
            >
              <PanelIcon />
            </button>
          </div>
        </header>

        <div className="relative flex min-h-0 w-full flex-1">
          <div ref={scrollRef} onScroll={onScroll} className="w-full flex-1 overflow-y-auto overflow-x-hidden px-4 py-5">
            <div className="mx-auto w-full max-w-3xl space-y-5">
              {!session?.messages.length && !liveText && !liveReasoning && (
                <div className="fade-in mt-16 flex flex-col items-center gap-3 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-2xl" style={{ background: 'var(--accent-soft)' }}><NekkoAvatar size={30} /></div>
                  <div>
                    <h2 className="text-[15px] font-semibold">
                      {!hasProvider ? 'Connect a model to get started' : needsModel ? 'Pick a model to get started' : 'What should Agent Nekko work on?'}
                    </h2>
                    <p className="mx-auto mt-1 max-w-sm text-[13px] text-ink-faint">
                      {!hasProvider
                        ? 'Add a local server (Ollama, LM Studio, vLLM) or a cloud provider in Models.'
                        : needsModel
                          ? 'This chat has no model yet. Choose one below the composer, or let ✨ Auto pick per message.'
                          : 'Ask a question or hand over a task. Use / for skills and prompts, @ to attach files, + for photos and folders.'}
                    </p>
                  </div>
                  {!hasProvider ? (
                    <button className="btn btn-primary" onClick={() => useStore.getState().setView('models')}>Open Models</button>
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
                used={ctx ? (ctx.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0)) : 0}
                windowTokens={ctx?.contextWindow ?? 0}
                session={session}
              />
              <ReplyStatus
                streaming={streaming}
                waiting={streaming && !liveText && liveActivity.length === 0}
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

        <div className="border-t border-line px-4 pb-4 pt-1.5">
          <div className="mx-auto w-full max-w-3xl">
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
                  window.kotrain
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
                    window.kotrain
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
              <EffortMenu />
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
                <textarea
                  ref={composerRef}
                  className="max-h-60 min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 text-sm text-ink outline-hidden placeholder:text-ink-faint"
                  rows={2}
                  placeholder={hasProvider ? 'Message Agent Nekko…  (/ for prompts, @ to attach files)' : 'Add a model provider in Models first'}
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
                          onClick={() => { closeAttachMenu(); void window.kotrain.addWorkspace(); }}
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
                  />
                  <UsageLimitsChip provider={activeProvider} session={session ?? undefined} cost={cost} />
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
                    <button className="btn btn-outline h-8 px-3 py-0 text-[12px]" onClick={() => window.kotrain.abortChat(sessionId)}>Stop</button>
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

/**
 * Provider + model as one legible control (instead of two microscopic selects):
 * a chip naming the current model that opens a flat picker of every provider's
 * models, grouped by provider, starred on top, Auto first.
 */
function ModelPicker({
  providers,
  providerId,
  models,
  modelId,
  open,
  onOpenChange,
  needsChoice,
  hint,
  onProvider,
  onModel,
}: {
  providers: ProviderConfig[];
  providerId: string | null;
  models: ModelInfo[];
  modelId: string | null;
  /** Open state is owned by the pane so the "choose a model" nudges can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** No model picked yet: the chip asks for one instead of reading as a setting. */
  needsChoice?: boolean;
  /** One-shot nudge shown over the chip; the pane retires it once the menu opens. */
  hint?: string | null;
  onProvider: (id: string) => void;
  onModel: (providerId: string, id: string) => void;
}) {
  const settings = useStore((s) => s.settings);
  const refreshSettings = useStore((s) => s.refreshSettings);
  const setOpen = (next: boolean) => onOpenChange(next);
  const [query, setQuery] = useState('');
  // Models per provider, fetched when the menu opens so the list covers every
  // provider (the `models` prop only holds the active provider's).
  const [byProvider, setByProvider] = useState<Record<string, ModelInfo[]>>({});
  const ref = useRef<HTMLDivElement>(null);
  const hintId = React.useId();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    Promise.all(
      providers.map((p) =>
        window.kotrain.listModels(p.id)
          .then((m) => [p.id, m] as const)
          .catch(() => [p.id, [] as ModelInfo[]] as const),
      ),
    ).then((entries) => { if (live) setByProvider(Object.fromEntries(entries)); });
    return () => { live = false; };
  }, [open, providers]);

  const favSet = new Set(settings?.favoriteModels ?? []);
  const toggleFavorite = async (key: string) => {
    const next = new Set(settings?.favoriteModels ?? []);
    next.has(key) ? next.delete(key) : next.add(key);
    await window.kotrain.updateSettings({ favoriteModels: [...next] });
    refreshSettings();
  };

  const modelsOf = (pid: string): ModelInfo[] =>
    byProvider[pid] ?? (pid === providerId ? models : []);
  const q = query.trim().toLowerCase();
  const matches = (m: ModelInfo) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);

  const groups = providers
    .map((p) => ({ provider: p, models: modelsOf(p.id).filter(matches) }))
    .filter((g) => g.models.length > 0);
  const starred = groups.flatMap((g) =>
    g.models
      .filter((m) => favSet.has(`${g.provider.id}::${m.id}`))
      .map((m) => ({ provider: g.provider, model: m })),
  );
  const total = providers.reduce((n, p) => n + modelsOf(p.id).length, 0);

  const providerLabel = providers.find((p) => p.id === providerId)?.label ?? 'No provider';
  const currentName =
    modelId === AUTO_MODEL_ID ? '✨ Auto' : models.find((m) => m.id === modelId)?.name ?? 'No model';

  const pick = (pid: string, mid: string) => {
    if (pid !== providerId) onProvider(pid);
    onModel(pid, mid);
    setOpen(false);
  };

  const row = (p: ProviderConfig, m: ModelInfo, showProvider: boolean) => {
    const key = `${p.id}::${m.id}`;
    const fav = favSet.has(key);
    const selected = p.id === providerId && modelId === m.id;
    const price = formatModelPriceLabel({ modelId: m.id, auth: p.auth, isLocal: isLocalProvider(p.kind) });
    return (
      <div
        key={key}
        className={`flex w-full items-center rounded-lg hover:bg-surface-2 ${selected ? 'text-accent' : ''}`}
      >
        <button
          role="option"
          aria-selected={selected}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-[12px]"
          onClick={() => pick(p.id, m.id)}
        >
          <span className="min-w-0 truncate">{m.name}</span>
          {price && <span className="ml-auto shrink-0 text-[10px] text-ink-faint" title="Estimated list price per 1M tokens">{price}</span>}
          {showProvider && <span className="shrink-0 text-[10px] text-ink-faint">{p.label}</span>}
        </button>
        <button
          className={`shrink-0 rounded-sm p-1.5 ${fav ? 'text-accent' : 'text-ink-faint hover:text-ink'}`}
          title={fav ? 'Unstar' : 'Star (pin to the top of this list)'}
          aria-label={fav ? `Unstar ${m.name}` : `Star ${m.name}`}
          aria-pressed={fav}
          onClick={() => toggleFavorite(key)}
        >
          <StarIcon className="h-3.5 w-3.5" filled={fav} />
        </button>
      </div>
    );
  };

  const header = (label: string) => (
    <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</p>
  );

  return (
    <div ref={ref} className="relative min-w-0 max-w-[240px]">
      {/* The nudge rides above the chip as a tooltip rather than a strip in the
          composer: it says its piece without pushing the composer down, and the
          menu it asks for opens into the same space, replacing it. */}
      {hint && !open && (
        <div
          id={hintId}
          role="tooltip"
          className="fade-in pointer-events-none absolute bottom-full left-0 z-30 mb-2 w-max max-w-[260px] rounded-xl border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
            background: 'var(--surface)',
          }}
        >
          <span className="font-medium text-accent">Choose a model</span>
          <span className="text-ink-soft"> · {hint}</span>
          <span
            className="absolute bottom-[-5px] left-4 h-2 w-2 rotate-45 border-b border-r"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)',
              background: 'var(--surface)',
            }}
          />
        </div>
      )}
      <button
        className="ctl-menu max-w-full"
        style={needsChoice ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-describedby={hint && !open ? hintId : undefined}
        title={needsChoice ? 'This chat has no model yet - pick one' : `Model: ${currentName} · ${providerLabel}`}
      >
        <span className="min-w-0 truncate">{needsChoice ? 'Choose a model' : currentName}</span>
        <span className="ctl-menu-label hidden min-w-0 truncate md:inline">· {providerLabel}</span>
        <span className="ctl-caret">▾</span>
      </button>
      {/* The menu opens rightwards from the chip's own left edge: the picker is
          the leftmost control of its row and the menu is wider than the chip, so
          anchoring it right hung it outside the pane, over the sidebar. */}
      {open && (
        <div className="card absolute bottom-full left-0 z-40 mb-2 flex max-h-96 w-80 max-w-[calc(100vw-2rem)] flex-col p-1.5 shadow-lg">
          {total > 8 && (
            <input
              className="input mb-1 rounded-lg px-2.5 py-1 text-[12px]"
              placeholder="Filter models…"
              value={query}
              autoFocus
              aria-label="Filter models"
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="Model">
            {providers.length === 0 && <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">No provider configured.</p>}
            {providers.length > 0 && groups.length === 0 && (
              <p className="px-2.5 py-1.5 text-[11px] text-ink-faint">{q ? 'No models match.' : 'No models available.'}</p>
            )}
            {total > 1 && !q && (
              <button
                role="option"
                aria-selected={modelId === AUTO_MODEL_ID}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] hover:bg-surface-2 ${modelId === AUTO_MODEL_ID ? 'text-accent' : ''}`}
                onClick={() => { onModel(providerId ?? '', AUTO_MODEL_ID); setOpen(false); }}
                title="Agent Nekko picks the best model for each message"
              >
                ✨ Auto <span className="text-[11px] text-ink-faint">(pick best)</span>
              </button>
            )}
            {starred.length > 0 && !q && (
              <>
                {header('★ Starred')}
                {starred.map((s) => row(s.provider, s.model, true))}
              </>
            )}
            {groups.map((g) => (
              <React.Fragment key={g.provider.id}>
                {header(g.provider.label)}
                {g.models.map((m) => row(g.provider, m, false))}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * How hard ✨ Auto leans on capability for this chat. Sits beside the model chip
 * and only while Auto is selected, so the strip doesn't carry a control that
 * does nothing.
 */
function AutoQualityMenu({ quality, onPick }: { quality: AutoQuality; onPick: (q: AutoQuality) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        className="ctl-menu whitespace-nowrap"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Auto profile: ${AUTO_QUALITY_META[quality].label} - ${AUTO_QUALITY_META[quality].description}`}
      >
        <span className="ctl-menu-label">Auto</span>
        {AUTO_QUALITY_META[quality].label}
        <span className="ctl-caret">▾</span>
      </button>
      {open && (
        <div className="card absolute bottom-8 left-0 z-40 w-60 p-1.5 shadow-lg" role="menu">
          {AUTO_QUALITIES.map((q) => (
            <button
              key={q}
              role="menuitemradio"
              aria-checked={quality === q}
              className={`flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${quality === q ? 'text-accent' : ''}`}
              onClick={() => { onPick(q); setOpen(false); }}
            >
              <span className="text-[13px] font-medium">{AUTO_QUALITY_META[q].label}</span>
              <span className="text-[11px] text-ink-faint">{AUTO_QUALITY_META[q].description}</span>
            </button>
          ))}
          <p className="border-t border-line px-2.5 pb-0.5 pt-1.5 text-[10px] text-ink-faint">Applies to this chat only.</p>
        </div>
      )}
    </div>
  );
}

/** One step of an assistant turn: a tool call, a reasoning block, or a bit of
 *  narration text between tools. Grouped into a single collapsible section. */
type Activity =
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'reasoning'; text: string; duration: number | null }
  | { kind: 'note'; text: string };

/** A render block of the transcript: a message bubble (user or the final
 *  assistant answer) or a grouped run of the model's working steps. */
type StreamBlock =
  | { type: 'msg'; message: ChatMessage }
  | { type: 'activity'; key: string; items: Activity[] };

/**
 * Fold a transcript into render blocks, collapsing each run of the model's
 * working steps (reasoning, tool calls, and inter-tool narration) into one
 * activity group so a many-step turn reads as a single expandable line instead
 * of a wall of "Used <tool>" rows. Only the final answer stays a bubble.
 */
function toStreamBlocks(messages: ChatMessage[]): StreamBlock[] {
  const blocks: StreamBlock[] = [];
  let run: Activity[] = [];
  let runKey = '';
  const flush = () => {
    if (run.length) { blocks.push({ type: 'activity', key: `act_${runKey}`, items: run }); run = []; }
  };
  // The turn's answer is the last assistant message's own text, even when that
  // message also made tool calls, a run cut short by the step budget, an abort,
  // or a model that concludes in the same message as its final tool call.
  // Without this its wrap-up would fold into the collapsed activity group and
  // vanish; mid-run narration still folds in as before.
  let lastAssistant = -1;
  messages.forEach((m, i) => { if (m.role === 'assistant') lastAssistant = i; });

  messages.forEach((m, i) => {
    if (m.role === 'tool') return;
    if (m.role === 'user') { flush(); blocks.push({ type: 'msg', message: m }); return; }
    // Assistant messages that still call tools are working steps; the one that
    // stops calling tools is the answer.
    if (m.toolCalls?.length) {
      const isFinalAnswer = i === lastAssistant && m.content.trim().length > 0;
      if (!run.length) runKey = `${m.id}_${i}`;
      if (m.reasoning) run.push({ kind: 'reasoning', text: m.reasoning, duration: m.reasoningSeconds ?? null });
      // Mid-run narration folds into the group; the final message's text is the
      // turn's answer and is surfaced as its own bubble instead.
      if (m.content.trim() && !isFinalAnswer) run.push({ kind: 'note', text: m.content });
      m.toolCalls.forEach((c) => run.push({ kind: 'tool', call: c }));
      if (isFinalAnswer) { flush(); blocks.push({ type: 'msg', message: m }); }
    } else {
      flush();
      blocks.push({ type: 'msg', message: m });
    }
  });
  flush();
  return blocks;
}

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

/** Short local time for a message timestamp (e.g. "3:42 PM"). */
function fmtTime(ts: number): string {
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

/**
 * A collapsed, expandable summary of a run of the model's working steps. Reads
 * as one line ("Worked on 6 steps · read_file, grep") that expands to the
 * individual tool calls, reasoning, and narration. Entrance animation only
 * while live-streaming; persisted groups render statically so the end-of-turn
 * handoff doesn't replay it.
 */
function ActivityGroup({ items, streaming = false }: { items: Activity[]; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  const tools = items.filter((it): it is Extract<Activity, { kind: 'tool' }> => it.kind === 'tool');
  const toolCount = tools.length;
  const names = Array.from(new Set(tools.map((t) => t.call.name)));
  const summary = streaming
    ? (toolCount ? `Working · ${tools[tools.length - 1].call.name}` : 'Thinking')
    : (toolCount ? `Worked on ${toolCount} step${toolCount === 1 ? '' : 's'}` : 'Thought it through');
  return (
    <div className={`${streaming ? 'fade-in ' : ''}mt-1 font-mono text-[12px]`}>
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        <ToolStepIcon className="h-3 w-3 shrink-0 text-accent" />
        <span className="font-medium text-ink-soft">{summary}</span>
        {!streaming && names.length > 0 && <span className="min-w-0 truncate text-ink-faint">· {names.join(', ')}</span>}
        {streaming && <span className="dots" />}
      </button>
      {open && (
        <div className="ml-[7px] mt-0.5 space-y-0.5 border-l border-line pl-2.5">
          {items.map((it, i) => {
            if (it.kind === 'tool') return <ToolCard key={`${it.call.id}_${i}`} call={it.call} />;
            if (it.kind === 'reasoning') return <ReasoningBlock key={`r${i}`} text={it.text} live={false} duration={it.duration} />;
            return (
              <div key={`n${i}`} className="py-0.5 font-sans text-[13px] text-ink-soft">
                <Markdown text={it.text} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The live subtext under the conversation: while a turn streams it shows
 * elapsed time, throughput, and tokens generated; right after a turn it shows
 * the completion summary; idle, it keeps a muted summary of the last turn.
 * All three render as the same single row, so the transcript's tail never
 * changes height.
 */
function ReplyStatus({
  streaming, waiting, elapsed, tps, out, last, done,
}: {
  // `elapsed` is how long the reply has been running; `tps` is the model's decode
  // rate over the time it spent generating, so the two deliberately don't divide
  // into each other (a turn spends much of its wall clock running tools).
  streaming: boolean; waiting: boolean; elapsed: number; tps: number; out: number;
  last: { out: number; tps: number; secs: number } | null;
  done?: string | null;
}) {
  if (streaming) {
    return (
      <div className="fade-in flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1 text-[12px] text-ink-faint">
        <span className="flex items-center gap-2 text-ink-soft"><MiniNekko size={16} /> {waiting ? 'Nekko is working' : 'Streaming'}<span className="dots" /></span>
        {elapsed > 0 && <span>· {elapsed}s</span>}
        {tps > 0 && <span title="Output tokens per second while the model was generating">· {formatRate(tps)} tok/s</span>}
        {out > 0 && <span>· {fmtTok(out)} tokens</span>}
      </div>
    );
  }
  if (done) {
    return (
      <div className="fade-in flex items-center gap-2 pt-1 text-[12px]" style={{ color: 'var(--success)' }} role="status">
        <span>✓</span> {done}
      </div>
    );
  }
  if (last && last.out > 0) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[11px] text-ink-faint/80">
        <span>Last reply</span>
        <span>· {fmtTok(last.out)} tokens</span>
        {last.tps > 0 && <span title="Output tokens per second while the model was generating">· {formatRate(last.tps)} tok/s</span>}
        {last.secs > 0 && <span>· {last.secs}s</span>}
      </div>
    );
  }
  return null;
}

/** Compact thinking indicator — matches tool card style. */
function ReasoningBlock({ text, live, duration }: { text: string; live: boolean; duration: number | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[12px] font-mono text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        <ThoughtIcon className="h-3 w-3 shrink-0" />
        <span>{live ? 'Thinking…' : duration != null ? `Thought for ${duration}s` : 'Thought process'}</span>
      </button>
      {open && <pre className="ml-[18px] mt-0.5 max-h-60 overflow-y-auto whitespace-pre-wrap border-l border-line pl-2 text-[12px] font-mono leading-relaxed text-ink-faint">{text}</pre>}
    </div>
  );
}

function MessageBubble({
  message,
  onResend,
  onReset,
  onImageClick,
  onImageContextMenu,
  chronological,
}: {
  message: ChatMessage;
  onResend?: (id: string, text: string) => void;
  /** Rewind the chat to this message and re-run it (replaces the old Regenerate). */
  onReset?: (id: string, text: string) => void;
  onImageClick?: (src: string) => void;
  onImageContextMenu?: (e: React.MouseEvent, src: string) => void;
  chronological?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const isUser = message.role === 'user';
  const displayText = isUser && message.skill ? message.skill.input : message.content;
  const [draft, setDraft] = useState(displayText);
  if (message.role === 'tool') return null;
  // Animate only genuinely-new content (the optimistic user bubble and the live
  // stream). Persisted messages render statically, so the optimistic→saved and
  // live→saved swaps at the end of a turn don't replay the entrance.
  const entering = message.id === 'tmp' || message.id === 'live';
  const copy = () => {
    navigator.clipboard?.writeText(message.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  };

  if (editing) {
    return (
      <div className="flex justify-end">
        <div className="w-full max-w-[85%]">
          <textarea className="input max-h-48 min-h-[60px] resize-none text-[14px]" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} />
          <div className="mt-1.5 flex justify-end gap-2">
            <button className="btn btn-ghost py-1 text-[12px]" onClick={() => { setEditing(false); setDraft(displayText); }}>Cancel</button>
            <button className="btn btn-primary py-1 text-[12px]" onClick={() => { setEditing(false); onResend?.(message.id, draft); }}>Save &amp; send</button>
          </div>
        </div>
      </div>
    );
  }

  // In chronological mode, render reasoning, tools, and text as separate
  // interleaved blocks so the layout is consistent with the live streaming view.
  if (chronological && !isUser) {
    const parts: React.ReactNode[] = [];
    if (message.reasoning) {
      parts.push(<ReasoningBlock key="reasoning" text={message.reasoning} live={false} duration={message.reasoningSeconds ?? null} />);
    }
    if (displayText) {
      parts.push(
        <div key="text" className={`group ${entering ? 'fade-in ' : ''}flex justify-start`}>
          <div className="msg-ai">
            <Markdown text={message.content} />
            {displayText && message.content && (
              <div className="mt-1 flex gap-3 text-[11px] text-ink-faint opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                <button onClick={copy} title="Copy message" className="hover:text-ink">{copied ? '✓ copied' : 'Copy'}</button>
              </div>
            )}
          </div>
        </div>,
      );
    }
    if (message.toolCalls?.length) {
      message.toolCalls.forEach((c) => parts.push(<ToolCard key={c.id} call={c} />));
    }
    return <>{parts}</>;
  }

  return (
    <div className={`group ${entering ? 'fade-in ' : ''}flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={isUser ? 'msg-user' : 'msg-ai'}>
        {isUser && message.skill && (
          <span className="skill-pill mb-2 inline-flex text-[11px]">
            <span className="skill-pill-slash">/</span>{message.skill.name}
          </span>
        )}
        {isUser && message.images?.length ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.images.map((image, i) => (
              <img
                key={`${image.slice(0, 24)}-${i}`}
                src={image}
                alt={`Attached image ${i + 1}`}
                className="h-[104px] w-[104px] cursor-pointer rounded-lg object-cover"
                onClick={() => onImageClick?.(image)}
                onContextMenu={(e) => onImageContextMenu?.(e, image)}
                title="Click to preview · right-click to copy or save"
              />
            ))}
          </div>
        ) : null}
        {!isUser && message.reasoning && (
          <ReasoningBlock text={message.reasoning} live={false} duration={message.reasoningSeconds ?? null} />
        )}
        {/* Your own messages render as markdown too: people type dashed lists and
            `code` in the composer and expect them to come out formatted. */}
        {displayText && <Markdown text={isUser ? displayText : message.content} />}
        {message.toolCalls?.map((c) => <ToolCard key={c.id} call={c} />)}
        {displayText && message.content && (
          <div className={`mt-1.5 flex items-center gap-3 text-[11px] text-ink-faint opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 ${isUser ? 'justify-end' : ''}`}>
            {isUser && message.createdAt > 0 && (
              <span className="text-ink-faint/70" title={new Date(message.createdAt).toLocaleString()}>{fmtTime(message.createdAt)}</span>
            )}
            <button onClick={copy} title="Copy prompt" className="hover:text-ink">{copied ? '✓ copied' : 'Copy'}</button>
            {onResend && <button onClick={() => { setDraft(displayText); setEditing(true); }} title="Edit & resend" className="hover:text-ink">Edit</button>}
            {onReset && (
              <button
                onClick={() => onReset(message.id, displayText)}
                title="Rewind the chat to this message and re-run it"
                className="hover:text-ink"
              >
                Reset here
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One tool invocation, collapsed to a single line. Neutral coloring on
 * purpose: danger signaling belongs to the approval flow, not to every bash
 * call, so real warnings keep their weight.
 */
function ToolCard({ call }: { call: ToolCall }) {
  const isSpawn = call.name === 'spawn_agent';
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 font-mono text-[12px]">
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-ink-faint hover:text-ink-soft"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="w-3 shrink-0 text-[10px]">{open ? '▾' : '▸'}</span>
        {isSpawn && <RobotIcon className="h-3 w-3 shrink-0 text-accent" />}
        <span className="font-medium">Used <span className="font-mono text-ink-soft">{call.name}</span> tool</span>
      </button>
      {open && <pre className="ml-[18px] mt-0.5 overflow-x-auto whitespace-pre-wrap border-l border-line pl-2 text-ink-faint">{JSON.stringify(call.input, null, 2)}</pre>}
    </div>
  );
}

/**
 * The tool-approval prompt: the highest-stakes moment in the app, so it gets a
 * deliberate entrance, keyboard focus (Deny by default), and Y / N / Esc keys.
 */
function ApprovalBar({ approval, onDecide }: { approval: PendingApproval; onDecide: (ok: boolean) => void }) {
  const denyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { denyRef.current?.focus(); }, []);
  const color =
    approval.severity === 'high' ? 'var(--danger)' : approval.severity === 'medium' ? 'var(--warning)' : 'var(--ink-faint)';
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); onDecide(true); }
    else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') { e.preventDefault(); onDecide(false); }
  };
  return (
    <div
      className="slide-up border-t border-line px-5 py-3"
      style={{ background: 'var(--surface-2)' }}
      role="alertdialog"
      aria-label={`Approval required: ${approval.reason}`}
      onKeyDown={onKeyDown}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <ShieldIcon className="h-5 w-5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Approval required</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ background: color }}>{approval.severity}</span>
            <span className="text-[12px] text-ink-faint">{approval.reason}</span>
          </div>
          <code className="mt-0.5 block truncate font-mono text-[12px] text-ink-soft">
            {String((approval.call.input as Record<string, unknown>).command ?? JSON.stringify(approval.call.input))}
          </code>
        </div>
        <button ref={denyRef} className="btn btn-outline" onClick={() => onDecide(false)} title="Deny (N or Esc)">Deny</button>
        <button className="btn btn-primary" onClick={() => onDecide(true)} title="Approve (Y)">Approve</button>
      </div>
    </div>
  );
}
